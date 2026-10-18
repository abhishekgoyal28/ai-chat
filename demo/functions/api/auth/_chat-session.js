/**
 * Starts or resumes the visitor's conversation on the ai-chat deployment.
 * The same agent + user always maps to the same conversation, so calling this
 * again resumes it and returns a fresh token.
 */
export async function startChatSession(env, identity) {
  const response = await fetch(`${String(env.AIC_API_URL ?? '').replace(/\/+$/, '')}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AIC_HOST_API_KEY}` },
    body: JSON.stringify({ agent: env.AIC_AGENT_SLUG, user: { id: identity.userId, name: identity.userName } }),
  });
  if (!response.ok) {
    console.error(`ai-chat session creation failed (${response.status}):`, await response.text());
    return null;
  }
  const session = await response.json();
  return {
    token: session.token,
    apiUrl: session.apiUrl,
    socketUrl: session.socketUrl,
    conversationId: session.conversationId,
    userName: identity.userName,
  };
}
