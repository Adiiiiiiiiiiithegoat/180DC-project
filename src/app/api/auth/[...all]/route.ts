import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Sign-up, sign-in, sign-out and session endpoints, all served by Better Auth.
export const { GET, POST } = toNextJsHandler(auth);
