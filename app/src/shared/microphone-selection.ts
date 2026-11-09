export function hasChosenMicrophone(deviceId: string | null): deviceId is string {
  return Boolean(deviceId) && deviceId !== 'default';
}
