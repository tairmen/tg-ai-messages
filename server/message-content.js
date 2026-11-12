export function telegramMessageContent(message) {
  const mediaType = message.media?.className || null;
  const actionType = message.action?.className || null;
  return {
    body:
      message.message ||
      (mediaType
        ? "[" + mediaType + "]"
        : actionType
          ? "[" + actionType + "]"
          : ""),
    metadata: {
      ...(mediaType ? { media_type: mediaType } : {}),
      ...(actionType ? { action_type: actionType } : {}),
    },
  };
}
