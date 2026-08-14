use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IPC_MESSAGE_BYTES: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const RUNTIME_WAKE_TIMEOUT: Duration = Duration::from_millis(2_500);

fn main() {
    let mut hook_input = None;
    let result = (|| -> Result<(), ()> {
        let agent = parse_agent_arg().ok_or(())?;
        let input = read_hook_input().ok_or(())?;
        hook_input = Some(input.clone());
        let event = map_hook_event(agent, &input, now_ms()).ok_or(())?;
        send_event(&event).map_err(|_| ())
    })();

    let _ = result;
    if hook_input
        .as_ref()
        .and_then(|value| value.get("hook_event_name"))
        .and_then(Value::as_str)
        == Some("Stop")
    {
        let _ = io::stdout().write_all(b"{}\n");
    }
}

#[derive(Clone, Copy)]
enum AgentKind {
    Codex,
    Claude,
    WorkBuddy,
}

impl AgentKind {
    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude-code",
            Self::WorkBuddy => "workbuddy",
        }
    }
}

fn parse_agent_arg() -> Option<AgentKind> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg != "--agent" {
            continue;
        }
        return match args.next()?.as_str() {
            "codex" => Some(AgentKind::Codex),
            "claude" | "claude-code" => Some(AgentKind::Claude),
            "workbuddy" => Some(AgentKind::WorkBuddy),
            _ => None,
        };
    }
    None
}

fn read_hook_input() -> Option<Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_HOOK_INPUT_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn map_hook_event(agent: AgentKind, input: &Value, occurred_at: u64) -> Option<Value> {
    let object = input.as_object()?;
    let hook_name = object.get("hook_event_name")?.as_str()?;
    let state = match hook_name {
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => "working",
        "PermissionRequest" => "waiting",
        "Stop" => "ready",
        "StopFailure" => "blocked",
        "SessionEnd" => "idle",
        _ => return None,
    };
    let session_id = valid_identifier(object.get("session_id")?, 160)?;
    let turn_id = object
        .get("turn_id")
        .and_then(|value| valid_identifier(value, 160));
    let mut event = Map::new();
    event.insert("schemaVersion".into(), json!(1));
    event.insert("agent".into(), json!(agent.id()));
    event.insert("sessionId".into(), json!(session_id));
    if let Some(turn_id) = turn_id {
        event.insert("turnId".into(), json!(turn_id));
    }
    event.insert("state".into(), json!(state));
    event.insert("occurredAt".into(), json!(occurred_at));
    event.insert("capabilities".into(), json!(["observeLifecycle"]));
    if hook_name == "PermissionRequest" {
        event.insert("request".into(), json!({ "kind": "permission" }));
    }
    Some(Value::Object(event))
}

fn valid_identifier(value: &Value, max_len: usize) -> Option<&str> {
    let value = value.as_str()?;
    if value.is_empty()
        || value.len() > max_len
        || value.chars().any(|character| character.is_control())
    {
        return None;
    }
    Some(value)
}

fn send_event(event: &Value) -> io::Result<()> {
    let paths = runtime_paths().ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    if let Some(explicit) = paths.explicit_discovery.as_deref() {
        let discovery = read_discovery_at(explicit)
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        return send_event_to_discovery(event, &discovery);
    }

    if let Some(path) = paths.brainpet_discovery.as_deref() {
        if let Some(discovery) = read_discovery_at(path) {
            if send_event_to_discovery(event, &discovery).is_ok() {
                return Ok(());
            }
        }
    }

    if event.get("state").and_then(Value::as_str) == Some("idle") {
        let discovery = paths
            .openpets_development_discovery
            .as_deref()
            .and_then(read_discovery_at)
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        return send_event_to_discovery(event, &discovery);
    }

    match paths.install_marker.as_deref().map(launch_installed_runtime) {
        Some(LaunchStatus::Launched) => {
            let deadline = Instant::now() + RUNTIME_WAKE_TIMEOUT;
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
                if let Some(discovery) = paths
                    .brainpet_discovery
                    .as_deref()
                    .and_then(read_discovery_at)
                {
                    if send_event_to_discovery(event, &discovery).is_ok() {
                        return Ok(());
                    }
                }
            }
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        Some(LaunchStatus::Invalid) => {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        Some(LaunchStatus::Missing) | None => {}
    }

    let discovery = paths
        .openpets_development_discovery
        .as_deref()
        .and_then(read_discovery_at)
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    send_event_to_discovery(event, &discovery)
}

fn send_event_to_discovery(event: &Value, discovery: &Discovery) -> io::Result<()> {
    let request = json!({
        "id": request_id(),
        "version": 1,
        "token": discovery.token.as_str(),
        "method": "agent.activity",
        "params": event,
    });
    let mut line = serde_json::to_vec(&request)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    line.push(b'\n');
    if line.len() > MAX_IPC_MESSAGE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    write_endpoint(&discovery.endpoint, &line)
}

struct Discovery {
    endpoint: String,
    token: String,
}

fn read_discovery_at(path: &Path) -> Option<Discovery> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() as usize > MAX_IPC_MESSAGE_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value.get("protocol")?.as_str()? != "openpets-ipc"
        || value.get("protocolVersion")?.as_u64()? != 1
    {
        return None;
    }
    let endpoint = value.get("endpoint")?.as_str()?.to_owned();
    let token = value.get("token")?.as_str()?.to_owned();
    if !(16..=256).contains(&token.len()) || !valid_endpoint(&endpoint) {
        return None;
    }
    Some(Discovery { endpoint, token })
}

struct RuntimePaths {
    explicit_discovery: Option<PathBuf>,
    brainpet_discovery: Option<PathBuf>,
    openpets_development_discovery: Option<PathBuf>,
    install_marker: Option<PathBuf>,
}

fn runtime_paths() -> Option<RuntimePaths> {
    if let Some(path) = env::var_os("OPENPETS_DISCOVERY_FILE") {
        return Some(RuntimePaths {
            explicit_discovery: Some(PathBuf::from(path)),
            brainpet_discovery: None,
            openpets_development_discovery: None,
            install_marker: None,
        });
    }
    #[cfg(target_os = "windows")]
    {
        let roaming = env::var_os("APPDATA")?;
        let local = env::var_os("LOCALAPPDATA")?;
        return Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(PathBuf::from(&roaming).join("BrainPet/runtime/ipc.json")),
            openpets_development_discovery: Some(PathBuf::from(roaming).join("OpenPets/runtime/ipc.json")),
            install_marker: Some(PathBuf::from(local).join("BrainPet/runtime-install.json")),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")?;
        return Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(PathBuf::from(&home).join("Library/Application Support/BrainPet/runtime/ipc.json")),
            openpets_development_discovery: Some(PathBuf::from(&home).join("Library/Application Support/OpenPets/runtime/ipc.json")),
            install_marker: Some(PathBuf::from(home).join("Library/Application Support/BrainPet/runtime-install.json")),
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = env::var_os("HOME")?;
        let config = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&home).join(".config"));
        if let Some(runtime) = env::var_os("XDG_RUNTIME_DIR") {
            return Some(RuntimePaths {
                explicit_discovery: None,
                brainpet_discovery: Some(PathBuf::from(&runtime).join("brainpet/ipc.json")),
                openpets_development_discovery: Some(PathBuf::from(runtime).join("openpets/ipc.json")),
                install_marker: Some(config.join("BrainPet/runtime-install.json")),
            });
        }
        Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(config.join("BrainPet/runtime/ipc.json")),
            openpets_development_discovery: Some(config.join("OpenPets/runtime/ipc.json")),
            install_marker: Some(config.join("BrainPet/runtime-install.json")),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LaunchStatus {
    Launched,
    Missing,
    Invalid,
}

fn launch_installed_runtime(marker_path: &Path) -> LaunchStatus {
    let metadata = match fs::symlink_metadata(marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return LaunchStatus::Missing,
        Err(_) => return LaunchStatus::Invalid,
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_IPC_MESSAGE_BYTES
    {
        return LaunchStatus::Invalid;
    }
    let marker: Value = match fs::read(marker_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(marker) => marker,
        None => return LaunchStatus::Invalid,
    };
    let executable = match validate_install_marker(&marker) {
        Some(path) => path,
        None => return LaunchStatus::Invalid,
    };
    let executable_metadata = match fs::symlink_metadata(&executable) {
        Ok(metadata) => metadata,
        Err(_) => return LaunchStatus::Invalid,
    };
    if !executable_metadata.is_file() || executable_metadata.file_type().is_symlink() {
        return LaunchStatus::Invalid;
    }

    let mut command = Command::new(executable);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    match command.spawn() {
        Ok(_) => LaunchStatus::Launched,
        Err(_) => LaunchStatus::Invalid,
    }
}

fn validate_install_marker(value: &Value) -> Option<PathBuf> {
    if value.get("schemaVersion")?.as_u64()? != 1
        || value.get("product")?.as_str()? != "brainpet"
        || value.get("platform")?.as_str()? != current_platform_id()
    {
        return None;
    }
    let executable = PathBuf::from(value.get("executablePath")?.as_str()?);
    if !executable.is_absolute() {
        return None;
    }
    let executable_name = executable.file_name()?.to_string_lossy().to_ascii_lowercase();
    let valid_name = if cfg!(target_os = "windows") {
        executable_name == "brainpet.exe"
    } else if cfg!(target_os = "linux") {
        executable_name == "brainpet" || executable_name == "brainpet.appimage"
    } else {
        executable_name == "brainpet"
    };
    if !valid_name {
        return None;
    }
    let version = value.get("appVersion")?.as_str()?;
    let channel = value.get("channel")?.as_str()?;
    let architecture = value.get("arch")?.as_str()?;
    let written_at = value.get("writtenAt")?.as_u64()?;
    if version.is_empty()
        || version.len() > 64
        || !matches!(channel, "stable" | "beta" | "dev")
        || architecture.len() < 2
        || architecture.len() > 32
        || !architecture.chars().all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
        || written_at == 0
    {
        return None;
    }
    Some(executable)
}

fn current_platform_id() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn valid_endpoint(endpoint: &str) -> bool {
    if endpoint.is_empty() || endpoint.len() > 240 || endpoint.contains('\0') {
        return false;
    }
    if let Some(address) = parse_tcp_endpoint(endpoint) {
        return is_private_ipv4(*address.ip());
    }
    #[cfg(target_os = "windows")]
    {
        (endpoint.starts_with(r"\\.\pipe\openpets-") || endpoint.starts_with(r"\\.\pipe\brainpet-")) && !endpoint.contains('/')
    }
    #[cfg(unix)]
    {
        Path::new(endpoint).is_absolute()
            && !Path::new(endpoint)
                .components()
                .any(|component| component == std::path::Component::ParentDir)
            && Path::new(endpoint)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| (name.starts_with("openpets-") || name.starts_with("brainpet-")) && name.ends_with(".sock"))
    }
}

fn write_endpoint(endpoint: &str, line: &[u8]) -> io::Result<()> {
    if let Some(address) = parse_tcp_endpoint(endpoint) {
        let mut stream = TcpStream::connect_timeout(&address.into(), CONNECT_TIMEOUT)?;
        stream.set_write_timeout(Some(CONNECT_TIMEOUT))?;
        return stream.write_all(line);
    }
    #[cfg(target_os = "windows")]
    {
        let mut pipe = OpenOptions::new().write(true).open(endpoint)?;
        return pipe.write_all(line);
    }
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        let mut stream = UnixStream::connect(endpoint)?;
        stream.set_write_timeout(Some(CONNECT_TIMEOUT))?;
        stream.write_all(line)
    }
}

fn parse_tcp_endpoint(endpoint: &str) -> Option<SocketAddrV4> {
    let rest = endpoint.strip_prefix("tcp://")?;
    if rest.contains('/') || rest.contains('?') || rest.contains('#') || rest.contains('@') {
        return None;
    }
    let (host, port) = rest.rsplit_once(':')?;
    Some(SocketAddrV4::new(host.parse().ok()?, port.parse().ok()?))
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_link_local()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn request_id() -> String {
    format!("brainpet-hook-{}-{}", std::process::id(), now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_mapping_keeps_only_lifecycle_fields() {
        let input = json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "prompt": "private",
            "transcript_path": "private"
        });
        assert_eq!(
            map_hook_event(AgentKind::Codex, &input, 123),
            Some(json!({
                "schemaVersion": 1,
                "agent": "codex",
                "sessionId": "session-1",
                "turnId": "turn-1",
                "state": "working",
                "occurredAt": 123,
                "capabilities": ["observeLifecycle"]
            }))
        );
    }

    #[test]
    fn claude_and_workbuddy_share_the_same_hook_shape() {
        let input = json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "session-2"
        });
        assert_eq!(
            map_hook_event(AgentKind::Claude, &input, 123)
                .and_then(|event| event.get("state").cloned()),
            Some(json!("waiting"))
        );
        assert_eq!(
            map_hook_event(AgentKind::WorkBuddy, &input, 123)
                .and_then(|event| event.get("agent").cloned()),
            Some(json!("workbuddy"))
        );
    }

    #[test]
    fn unsupported_events_are_ignored() {
        let input = json!({"hook_event_name": "Unknown", "session_id": "session-1"});
        assert_eq!(map_hook_event(AgentKind::Codex, &input, 123), None);
    }

    #[test]
    fn install_marker_never_accepts_an_arbitrary_executable() {
        let valid_name = if cfg!(target_os = "windows") { "brainpet.exe" } else { "brainpet" };
        let root = if cfg!(target_os = "windows") { r"C:\\Program Files\\BrainPet" } else { "/Applications/BrainPet" };
        let marker = json!({
            "schemaVersion": 1,
            "product": "brainpet",
            "executablePath": PathBuf::from(root).join(valid_name),
            "appVersion": "1.0.0",
            "channel": "stable",
            "platform": current_platform_id(),
            "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" },
            "writtenAt": 123
        });
        assert!(validate_install_marker(&marker).is_some());
        let mut invalid = marker;
        invalid["executablePath"] = json!(PathBuf::from(root).join(if cfg!(target_os = "windows") { "cmd.exe" } else { "sh" }));
        assert_eq!(validate_install_marker(&invalid), None);
    }
}
