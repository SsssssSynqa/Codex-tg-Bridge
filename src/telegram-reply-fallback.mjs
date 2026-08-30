const MISSING_REPLY_TARGET = 'message to be replied not found';

export function isMissingReplyTargetError(error) {
  const status = Number(error?.status);
  const message = String(error?.telegramDescription || error?.message || error || '').toLowerCase();
  return (!Number.isFinite(status) || status === 400) && message.includes(MISSING_REPLY_TARGET);
}

export async function sendWithMissingReplyFallback(send, params, { onFallback } = {}) {
  const hasReplyTarget = params?.reply_parameters?.message_id != null;
  const firstParams = hasReplyTarget
    ? {
        ...params,
        reply_parameters: {
          ...params.reply_parameters,
          allow_sending_without_reply: true,
        },
      }
    : params;

  try {
    return await send(firstParams);
  } catch (error) {
    if (!hasReplyTarget || !isMissingReplyTargetError(error)) throw error;

    onFallback?.(error);
    const fallbackParams = { ...params };
    delete fallbackParams.reply_parameters;
    return send(fallbackParams);
  }
}
