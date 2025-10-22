import { requireUser, ensureAuth } from "./auth.js";

// Convert a simple glob (e.g., '/protected(.*)' or '/admin/*') into a RegExp
function globToRegExp(glob) {
  // Escape regex special chars, then convert glob wildcards to regex
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Support (.*) passthrough, '*' for any segment, and '**' for deep match
  const withStars = escaped
    .replace(/\\\*\\\*/g, ".*") // '**' => '.*'
    .replace(/\\\*/g, "[^/]*"); // '*' => any segment (no slash)
  return new RegExp(`^${withStars}$`);
}

// Protect a list of route patterns (globs) with Clerk auth
// mode: 'api' (401 JSON) or 'redirect' (browser redirect to sign-in)
// authOptions: forwarded to ensureAuth (e.g., acceptsToken)
export function protectRoutes(patterns = [], { mode = "api", ...authOptions } = {}) {
  const regs = patterns.map(globToRegExp);
  
  return (req, res, next) => {
    const path = req.path || req.url || "";
    if (regs.some((re) => re.test(path))) {
      // Choose the appropriate guard based on mode
      const guard = mode === "redirect" ? requireUser() : ensureAuth(authOptions);
      return guard(req, res, next);
    }
    return next();
  };
}

export default protectRoutes;
