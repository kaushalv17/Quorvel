import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

// Routes anyone can hit without being signed in.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
])

// Static-asset probes: /favicon.ico, /favicon.png, /apple-touch-icon.png, robots.txt, etc.
// Browsers request these even though we never reference them. They 404, and Next renders the
// not-found page INSIDE <ClerkProvider>, so Clerk needs middleware context for these requests
// or auth() throws "can't detect clerkMiddleware()". Let them run through middleware but skip
// auth so they resolve to a clean 404 instead of a 500.
const isStaticAsset = createRouteMatcher([/\.[\w]+$/])

export default clerkMiddleware(async (auth, req) => {
  if (isStaticAsset(req) || isPublicRoute(req)) return
  await auth.protect() // anonymous -> redirected to sign-in
})

export const config = {
  matcher: [
    // Run on everything except Next internals -- INCLUDING root-level static assets, so a
    // 404 on e.g. /favicon.png still carries Clerk context and doesn't 500 during 404 render.
    "/((?!_next).*)",
    "/(api|trpc)(.*)",
  ],
}