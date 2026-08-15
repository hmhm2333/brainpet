!macro customUnInstall
  ; Removing the runtime marker makes every installed Bridge fail open. Keep
  ; user progress under %APPDATA%\BrainPet so a reinstall can restore it.
  Delete "$LOCALAPPDATA\BrainPet\runtime-install.json"
  Delete "$LOCALAPPDATA\BrainPet\runtime-install.json.bak"
  RMDir "$LOCALAPPDATA\BrainPet"
!macroend
