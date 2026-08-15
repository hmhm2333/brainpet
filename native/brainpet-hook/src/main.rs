use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod generated_contract;
use generated_contract::{
    AGENT_ACTIVITY_METHOD, AGENT_ACTIVITY_SCHEMA_VERSION, BRAINPET_APP_ID,
    BRAINPET_PRODUCT_DIRECTORY, CONNECT_ATTEMPT_MS, HOOK_DEADLINE_MS, IPC_PROTOCOL,
    IPC_PROTOCOL_VERSION, LIFECYCLE_STATES, MAX_IPC_MESSAGE_BYTES, RUNTIME_POLL_INTERVAL_MS,
};

const MAX_HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(CONNECT_ATTEMPT_MS);
const HOOK_DEADLINE: Duration = Duration::from_millis(HOOK_DEADLINE_MS);
const RUNTIME_POLL_INTERVAL: Duration = Duration::from_millis(RUNTIME_POLL_INTERVAL_MS);

fn main() {
    let _contract_identity = (
        generated_contract::ADAPTER_VERSION,
        generated_contract::BRAINPET_RUNTIME_NAMESPACE,
    );
    if env::args().any(|argument| argument == "--self-test") {
        let _ = io::stdout()
            .write_all(concat!("brainpet-hook ", env!("CARGO_PKG_VERSION"), " ok\n").as_bytes());
        return;
    }
    let deadline = Instant::now() + HOOK_DEADLINE;
    let mut hook_input = None;
    let result = (|| -> Result<(), ()> {
        let agent = parse_agent_arg().ok_or(())?;
        let input = read_hook_input().ok_or(())?;
        hook_input = Some(input.clone());
        let event = map_hook_event(agent, &input, now_ms()).ok_or(())?;
        send_event(&event, deadline).map_err(|_| ())
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
}

impl AgentKind {
    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
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
    let state = match (agent, hook_name) {
        (_, "UserPromptSubmit" | "PreToolUse" | "PostToolUse") => "working",
        (AgentKind::Claude, "PermissionRequest") => "waiting",
        (_, "Stop") => "ready",
        (AgentKind::Codex, "ErrorOccurred") => "blocked",
        (AgentKind::Claude, "StopFailure" | "ErrorOccurred") => "blocked",
        (_, "SessionEnd") => "idle",
        _ => return None,
    };
    if !LIFECYCLE_STATES.contains(&state) {
        return None;
    }
    let session_id = valid_identifier(object.get("session_id")?, 160)?;
    let turn_id = object
        .get("turn_id")
        .and_then(|value| valid_identifier(value, 160));
    let mut event = Map::new();
    event.insert("schemaVersion".into(), json!(AGENT_ACTIVITY_SCHEMA_VERSION));
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

fn send_event(event: &Value, deadline: Instant) -> io::Result<()> {
    let paths = runtime_paths().ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    if let Some(explicit) = paths.explicit_discovery.as_deref() {
        let discovery =
            read_discovery_at(explicit).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        return send_event_to_discovery(event, &discovery, deadline);
    }

    if let Some(path) = paths.brainpet_discovery.as_deref() {
        if let Some(discovery) = read_discovery_at(path) {
            if send_event_to_discovery(event, &discovery, deadline).is_ok() {
                return Ok(());
            }
        }
    }

    if event.get("state").and_then(Value::as_str) == Some("idle") {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }

    match paths
        .install_marker
        .as_deref()
        .map(launch_installed_runtime)
    {
        Some(LaunchStatus::Launched) => {
            while Instant::now() < deadline {
                thread::sleep(remaining_timeout(deadline)?.min(RUNTIME_POLL_INTERVAL));
                if let Some(discovery) = paths
                    .brainpet_discovery
                    .as_deref()
                    .and_then(read_discovery_at)
                {
                    if send_event_to_discovery(event, &discovery, deadline).is_ok() {
                        return Ok(());
                    }
                }
            }
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        Some(LaunchStatus::Invalid) => {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        Some(LaunchStatus::Missing) | None => {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
    }
}

fn send_event_to_discovery(
    event: &Value,
    discovery: &Discovery,
    deadline: Instant,
) -> io::Result<()> {
    let request = json!({
        "id": request_id(),
        "version": IPC_PROTOCOL_VERSION,
        "token": discovery.token.as_str(),
        "method": AGENT_ACTIVITY_METHOD,
        "params": event,
    });
    let mut line =
        serde_json::to_vec(&request).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    line.push(b'\n');
    if line.len() > MAX_IPC_MESSAGE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    write_endpoint(
        &discovery.endpoint,
        &line,
        remaining_timeout(deadline)?.min(CONNECT_ATTEMPT_TIMEOUT),
    )
}

fn remaining_timeout(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
}

struct Discovery {
    endpoint: String,
    token: String,
}

fn read_discovery_at(path: &Path) -> Option<Discovery> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_IPC_MESSAGE_BYTES
    {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value.get("protocol")?.as_str()? != IPC_PROTOCOL
        || value.get("protocolVersion")?.as_u64()? != IPC_PROTOCOL_VERSION
        || value.get("product")?.as_str()? != "brainpet"
        || value.get("appId")?.as_str()? != BRAINPET_APP_ID
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
    install_marker: Option<PathBuf>,
}

fn runtime_paths() -> Option<RuntimePaths> {
    if let Some(path) = env::var_os("OPENPETS_DISCOVERY_FILE") {
        return Some(RuntimePaths {
            explicit_discovery: Some(PathBuf::from(path)),
            brainpet_discovery: None,
            install_marker: None,
        });
    }
    #[cfg(target_os = "windows")]
    {
        let roaming = env::var_os("APPDATA")?;
        let local = env::var_os("LOCALAPPDATA")?;
        return Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(
                PathBuf::from(&roaming)
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime/ipc.json"),
            ),
            install_marker: Some(
                PathBuf::from(local)
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime-install.json"),
            ),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")?;
        return Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(
                PathBuf::from(&home)
                    .join("Library/Application Support")
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime/ipc.json"),
            ),
            install_marker: Some(
                PathBuf::from(home)
                    .join("Library/Application Support")
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime-install.json"),
            ),
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
                brainpet_discovery: Some(
                    PathBuf::from(&runtime)
                        .join(generated_contract::BRAINPET_RUNTIME_NAMESPACE)
                        .join("ipc.json"),
                ),
                install_marker: Some(
                    config
                        .join(BRAINPET_PRODUCT_DIRECTORY)
                        .join("runtime-install.json"),
                ),
            });
        }
        Some(RuntimePaths {
            explicit_discovery: None,
            brainpet_discovery: Some(
                config
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime/ipc.json"),
            ),
            install_marker: Some(
                config
                    .join(BRAINPET_PRODUCT_DIRECTORY)
                    .join("runtime-install.json"),
            ),
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
    let executable = match resolve_runtime_executable(marker_path) {
        Ok(Some(path)) => path,
        Ok(None) => return LaunchStatus::Missing,
        Err(()) => return LaunchStatus::Invalid,
    };
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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

#[derive(Debug, Eq, PartialEq)]
enum MarkerRuntime {
    Found(PathBuf),
    Missing,
    Corrupt,
    Unsafe,
}

fn resolve_runtime_executable(marker_path: &Path) -> Result<Option<PathBuf>, ()> {
    match read_marker_runtime(marker_path) {
        MarkerRuntime::Found(path) => return Ok(Some(path)),
        MarkerRuntime::Unsafe => return Err(()),
        MarkerRuntime::Missing | MarkerRuntime::Corrupt => {}
    }

    let backup_path = install_marker_backup_path(marker_path);
    match read_marker_runtime(&backup_path) {
        MarkerRuntime::Found(path) => return Ok(Some(path)),
        MarkerRuntime::Unsafe => return Err(()),
        MarkerRuntime::Missing | MarkerRuntime::Corrupt => {}
    }

    for candidate in default_runtime_candidates(marker_path) {
        if is_regular_executable(&candidate) {
            return Ok(Some(candidate));
        }
    }

    remove_regular_marker(marker_path);
    remove_regular_marker(&backup_path);
    Ok(None)
}

fn read_marker_runtime(path: &Path) -> MarkerRuntime {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return MarkerRuntime::Missing,
        Err(_) => return MarkerRuntime::Unsafe,
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_IPC_MESSAGE_BYTES
    {
        return MarkerRuntime::Unsafe;
    }
    let marker: Value = match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(marker) => marker,
        None => return MarkerRuntime::Corrupt,
    };
    let executable = match validate_install_marker(&marker) {
        Some(path) => path,
        None => return MarkerRuntime::Corrupt,
    };
    if is_regular_executable(&executable) {
        MarkerRuntime::Found(executable)
    } else {
        MarkerRuntime::Missing
    }
}

fn is_regular_executable(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn install_marker_backup_path(marker_path: &Path) -> PathBuf {
    let mut value = marker_path.as_os_str().to_os_string();
    value.push(".bak");
    PathBuf::from(value)
}

fn remove_regular_marker(path: &Path) {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        let _ = fs::remove_file(path);
    }
}

fn default_runtime_candidates(marker_path: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return marker_path
            .parent()
            .and_then(Path::parent)
            .map(|local_app_data| {
                vec![local_app_data
                    .join("Programs")
                    .join("brainpet")
                    .join("brainpet.exe")]
            })
            .unwrap_or_default();
    }
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from(
            "/Applications/BrainPet.app/Contents/MacOS/brainpet",
        )];
        if let Some(home) = marker_path.ancestors().nth(4) {
            candidates.push(
                home.join("Applications")
                    .join("BrainPet.app/Contents/MacOS/brainpet"),
            );
        }
        return candidates;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = marker_path;
        vec![
            PathBuf::from("/opt/BrainPet/brainpet"),
            PathBuf::from("/opt/brainpet/brainpet"),
        ]
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
    let executable_name = executable
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    let valid_name = if cfg!(target_os = "windows") {
        executable_name == "brainpet.exe"
    } else if cfg!(target_os = "linux") {
        executable_name == "brainpet" || valid_linux_appimage_name(&executable_name)
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
        || !architecture.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
        || written_at == 0
    {
        return None;
    }
    Some(executable)
}

fn valid_linux_appimage_name(name: &str) -> bool {
    if !name.starts_with("brainpet") || !name.ends_with(".appimage") {
        return false;
    }
    let middle = &name["brainpet".len()..name.len() - ".appimage".len()];
    middle.is_empty()
        || matches!(middle.as_bytes().first().copied(), Some(b'-' | b'_' | b'.'))
            && middle.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
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
        endpoint.starts_with(r"\\.\pipe\brainpet-") && !endpoint.contains('/')
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
                .is_some_and(|name| name.starts_with("brainpet-") && name.ends_with(".sock"))
    }
}

fn write_endpoint(endpoint: &str, line: &[u8], timeout: Duration) -> io::Result<()> {
    if let Some(address) = parse_tcp_endpoint(endpoint) {
        let mut stream = TcpStream::connect_timeout(&address.into(), timeout)?;
        stream.set_write_timeout(Some(timeout))?;
        return stream.write_all(line);
    }
    write_path_endpoint(endpoint, line, timeout)
}

fn write_path_endpoint(endpoint: &str, line: &[u8], timeout: Duration) -> io::Result<()> {
    let endpoint = endpoint.to_owned();
    let line = line.to_vec();
    run_io_with_timeout(timeout, move || {
        #[cfg(target_os = "windows")]
        return OpenOptions::new()
            .write(true)
            .open(endpoint)
            .and_then(|mut pipe| pipe.write_all(&line));
        #[cfg(unix)]
        {
            use std::os::unix::net::UnixStream;
            UnixStream::connect(endpoint).and_then(|mut stream| {
                stream.set_write_timeout(Some(timeout))?;
                stream.write_all(&line)
            })
        }
    })
}

fn run_io_with_timeout<F>(timeout: Duration, operation: F) -> io::Result<()>
where
    F: FnOnce() -> io::Result<()> + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(operation());
    });
    receiver
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => io::Error::from(io::ErrorKind::TimedOut),
            mpsc::RecvTimeoutError::Disconnected => io::Error::from(io::ErrorKind::BrokenPipe),
        })?
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
    fn blocking_path_io_respects_the_deadline() {
        let started = Instant::now();
        let result = run_io_with_timeout(Duration::from_millis(20), || {
            thread::sleep(Duration::from_millis(200));
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(150));
    }

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
    fn shared_adapter_conformance_fixture_matches_native_mappers() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../config/brainpet-adapter-conformance.json"
        ))
        .unwrap();
        let occurred_at = fixture.get("occurredAt").and_then(Value::as_u64).unwrap();
        let rejected = fixture
            .get("rejectedFields")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(
            rejected.len(),
            generated_contract::PRIVACY_REJECTED_FIELDS.len()
        );
        for case in fixture.get("cases").and_then(Value::as_array).unwrap() {
            let provider = case.get("provider").and_then(Value::as_str).unwrap();
            let agent = match provider {
                "codex" => AgentKind::Codex,
                "claude" => AgentKind::Claude,
                _ => continue,
            };
            let actual = map_hook_event(agent, case.get("input").unwrap(), occurred_at);
            let expected = case
                .get("expected")
                .filter(|value| !value.is_null())
                .cloned();
            assert_eq!(
                actual,
                expected,
                "conformance case {}",
                case.get("id").and_then(Value::as_str).unwrap()
            );
            if let Some(Value::Object(event)) = actual {
                for field in generated_contract::PRIVACY_REJECTED_FIELDS {
                    assert!(
                        !event.contains_key(*field),
                        "native mapper leaked rejected field {field}"
                    );
                }
            }
        }
    }

    #[test]
    fn claude_hook_shape_is_supported_without_hidden_probe_providers() {
        let input = json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "session-2"
        });
        assert_eq!(
            map_hook_event(AgentKind::Claude, &input, 123)
                .and_then(|event| event.get("state").cloned()),
            Some(json!("waiting"))
        );
    }

    #[test]
    fn unsupported_events_are_ignored() {
        let input = json!({"hook_event_name": "Unknown", "session_id": "session-1"});
        assert_eq!(map_hook_event(AgentKind::Codex, &input, 123), None);
        let claude_only =
            json!({"hook_event_name": "PermissionRequest", "session_id": "session-1"});
        assert_eq!(map_hook_event(AgentKind::Codex, &claude_only, 123), None);
        let codex_error = json!({"hook_event_name": "ErrorOccurred", "session_id": "session-1"});
        assert_eq!(
            map_hook_event(AgentKind::Codex, &codex_error, 123)
                .and_then(|event| event.get("state").cloned()),
            Some(json!("blocked"))
        );
    }

    #[test]
    fn install_marker_never_accepts_an_arbitrary_executable() {
        let valid_name = if cfg!(target_os = "windows") {
            "brainpet.exe"
        } else {
            "brainpet"
        };
        let root = if cfg!(target_os = "windows") {
            r"C:\\Program Files\\BrainPet"
        } else {
            "/Applications/BrainPet"
        };
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
        invalid["executablePath"] =
            json!(PathBuf::from(root).join(if cfg!(target_os = "windows") {
                "cmd.exe"
            } else {
                "sh"
            }));
        assert_eq!(validate_install_marker(&invalid), None);
    }

    #[test]
    fn corrupt_primary_marker_recovers_from_last_known_good_copy() {
        let root = env::temp_dir().join(format!(
            "brainpet-hook-marker-backup-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join(if cfg!(target_os = "windows") {
            "brainpet.exe"
        } else {
            "brainpet"
        });
        fs::write(&executable, b"fixture").unwrap();
        let marker_path = root.join("runtime-install.json");
        fs::write(&marker_path, b"{broken-json").unwrap();
        let marker = json!({
            "schemaVersion": 1,
            "product": "brainpet",
            "executablePath": executable,
            "appVersion": "1.0.0",
            "channel": "stable",
            "platform": current_platform_id(),
            "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" },
            "writtenAt": 123
        });
        fs::write(
            install_marker_backup_path(&marker_path),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        assert_eq!(
            resolve_runtime_executable(&marker_path).unwrap(),
            marker
                .get("executablePath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unrecoverable_regular_markers_are_removed_without_trusting_their_paths() {
        let root = env::temp_dir().join(format!(
            "brainpet-hook-marker-corrupt-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let marker_path = root.join("runtime-install.json");
        let backup_path = install_marker_backup_path(&marker_path);
        fs::write(&marker_path, b"{broken-primary").unwrap();
        fs::write(&backup_path, b"{broken-backup").unwrap();
        assert_eq!(resolve_runtime_executable(&marker_path), Ok(None));
        assert!(!marker_path.exists());
        assert!(!backup_path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_runtime_recovery_candidates_are_install_profile_bound() {
        #[cfg(target_os = "windows")]
        assert_eq!(
            default_runtime_candidates(Path::new(
                r"C:\Users\test\AppData\Local\BrainPet\runtime-install.json"
            )),
            vec![PathBuf::from(
                r"C:\Users\test\AppData\Local\Programs\brainpet\brainpet.exe"
            )]
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            default_runtime_candidates(Path::new(
                "/Users/test/Library/Application Support/BrainPet/runtime-install.json"
            )),
            vec![
                PathBuf::from("/Applications/BrainPet.app/Contents/MacOS/brainpet"),
                PathBuf::from("/Users/test/Applications/BrainPet.app/Contents/MacOS/brainpet"),
            ]
        );
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(
            default_runtime_candidates(Path::new(
                "/home/test/.config/BrainPet/runtime-install.json"
            )),
            vec![
                PathBuf::from("/opt/BrainPet/brainpet"),
                PathBuf::from("/opt/brainpet/brainpet"),
            ]
        );
    }

    #[test]
    fn discovery_identity_must_match_brainpet() {
        let root = env::temp_dir().join(format!(
            "brainpet-hook-target-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let discovery_path = root.join("ipc.json");
        let base = json!({
            "protocol": "openpets-ipc",
            "protocolVersion": 1,
            "product": "brainpet",
            "appId": "dev.brainpet.app",
            "endpoint": "tcp://127.0.0.1:37645",
            "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        });
        fs::write(&discovery_path, serde_json::to_vec(&base).unwrap()).unwrap();
        assert!(read_discovery_at(&discovery_path).is_some());
        let mut wrong_product = base;
        wrong_product["product"] = json!("openpets");
        wrong_product["appId"] = json!("dev.openpets.app");
        fs::write(&discovery_path, serde_json::to_vec(&wrong_product).unwrap()).unwrap();
        assert!(read_discovery_at(&discovery_path).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn linux_appimage_names_allow_versions_but_reject_unrelated_launchers() {
        assert!(valid_linux_appimage_name("brainpet-3.4.0-x86_64.appimage"));
        assert!(valid_linux_appimage_name("brainpet.appimage"));
        assert!(!valid_linux_appimage_name("not-brainpet.appimage"));
        assert!(!valid_linux_appimage_name("brainpet setup.appimage"));
    }
}
