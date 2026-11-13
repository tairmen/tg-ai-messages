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
      ...(message.replyTo?.replyToMsgId
        ? { reply_to_message_id: String(message.replyTo.replyToMsgId) }
        : {}),
      ...(message.reactions?.results?.length
        ? {
            reactions: message.reactions.results.map((item) => ({
              reaction:
                item.reaction?.emoticon ||
                (item.reaction?.documentId
                  ? "custom:" + String(item.reaction.documentId)
                  : item.reaction?.className || "unknown"),
              count: item.count,
            })),
          }
        : {}),
      ...(mediaType ? { media_type: mediaType } : {}),
      ...(actionType ? { action_type: actionType } : {}),
    },
  };
}
