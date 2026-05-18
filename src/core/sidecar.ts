export function computeSidecarPath(sidecarRoot: string, notePath: string): string {
  const encoded = notePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  return `${sidecarRoot}/${encoded}.annotation.json`
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
}
