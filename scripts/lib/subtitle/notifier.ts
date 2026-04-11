import { formatErrorMessage } from "./utils";

const TRANSCRIPTION_FAILURE_TITLE = "\u8f6c\u5f55\u5931\u8d25";

export async function notifyTranscriptionFailure({ progress, pageNo, bvid, cid }) {
  const sendKey = String(process.env.SERVER_CHAN_SEND_KEY ?? "").trim();
  if (!sendKey) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      "SERVER_CHAN_SEND_KEY is not configured, skipping transcription failure notification",
    );
    return;
  }

  const notificationUrl = `https://sctapi.ftqq.com/${sendKey}.send?title=${encodeURIComponent(TRANSCRIPTION_FAILURE_TITLE)}`;

  try {
    const response = await fetch(notificationUrl);
    if (!response.ok) {
      throw new Error(`ServerChan responded with ${response.status} ${response.statusText}`);
    }
    progress?.logPartStage?.(pageNo, "Subtitle", `Sent transcription failure notification for ${bvid} P${pageNo} (cid ${cid})`);
  } catch (error) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Failed to send transcription failure notification (${formatErrorMessage(error)})`,
    );
  }
}
