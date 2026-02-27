export function isHtmlPreviewCompletion(
  hasUsedTools: boolean,
  isEmptyResponse: boolean,
  lastToolName: string,
): boolean {
  return hasUsedTools && isEmptyResponse && lastToolName === 'html_preview';
}
