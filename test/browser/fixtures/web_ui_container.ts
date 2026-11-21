export type WebUIContainer = Readonly<{ baseUrl: string; imageID: string }>;

export async function sharedWebUIContainer(): Promise<WebUIContainer> {
  const baseUrl = process.env.FLOWAI_WEB_UI_ORIGIN;
  const imageID = process.env.FLOWAI_WEB_UI_IMAGE_ID;
  if (
    !baseUrl || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(baseUrl) ||
    !imageID || !/^sha256:[0-9a-f]{64}$/.test(imageID)
  ) {
    throw new Error("Use the hosted qualification entry point to supply the owned Web UI container");
  }
  return { baseUrl, imageID };
}
