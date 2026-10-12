export function allowsMicrophoneRequest(
  permission: string,
  mediaTypes: readonly string[] | undefined,
): boolean {
  return (
    permission === "media" &&
    mediaTypes !== undefined &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}

export function allowsMicrophoneCheck(
  permission: string,
  mediaType: string | undefined,
): boolean {
  return permission === "media" && mediaType === "audio";
}
