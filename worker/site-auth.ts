const USER_EMAIL_HEADER = "oai-authenticated-user-email";

export function requireAuthenticatedSiteUser(request: Request): Response | null {
  if (request.headers.get(USER_EMAIL_HEADER)) return null;
  return Response.json({ error: "Sign in required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
