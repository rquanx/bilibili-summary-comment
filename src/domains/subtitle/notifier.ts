import { formatErrorMessage } from "./utils";

const TRANSCRIPTION_FAILURE_TITLE = "\u8f6c\u5f55\u5931\u8d25";

interface ServerChanNotificationOptions {
  title: string;
  desp?: string | null;
  sendKey?: string | null;
  fetchImpl?: typeof fetch;
}

export async function sendServerChanNotification({
  title,
  desp = null,
  sendKey = process.env.SERVER_CHAN_SEND_KEY ?? "",
  fetchImpl = fetch,
}: ServerChanNotificationOptions) {
  const normalizedSendKey = String(sendKey ?? "").trim();
  if (!normalizedSendKey) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-send-key",
    } as const;
  }

  const normalizedTitle = String(title ?? "").trim();
  if (!normalizedTitle) {
    throw new Error("Missing required ServerChan title");
  }

  const body = new URLSearchParams({
    title: normalizedTitle,
  });
  const normalizedDesp = String(desp ?? "").trim();
  if (normalizedDesp) {
    body.set("desp", normalizedDesp);
  }

  const response = await fetchImpl(`https://sctapi.ftqq.com/${normalizedSendKey}.send`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`ServerChan responded with ${response.status} ${response.statusText}`);
  }

  return {
    ok: true,
    skipped: false,
  } as const;
}

export async function notifyTranscriptionFailure({ progress, pageNo, bvid, cid }) {
  try {
    const result = await sendServerChanNotification({
      title: TRANSCRIPTION_FAILURE_TITLE,
    });
    if (result.skipped) {
      progress?.logPartStage?.(
        pageNo,
        "Subtitle",
        "SERVER_CHAN_SEND_KEY is not configured, skipping transcription failure notification",
      );
      return;
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
