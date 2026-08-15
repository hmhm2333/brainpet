export interface OptionalLanPetPort {
  reclampPetWindows(): void;
}

const disabledPort: OptionalLanPetPort = {
  reclampPetWindows: () => undefined,
};

let activePort: OptionalLanPetPort = disabledPort;

export function configureOptionalLanPetPort(port: OptionalLanPetPort | null): void {
  activePort = port ?? disabledPort;
}

export function reclampOptionalLanPetWindows(): void {
  activePort.reclampPetWindows();
}
