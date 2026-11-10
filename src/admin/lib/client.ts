import Medusa from "@medusajs/js-sdk"
declare const __BACKEND_URL__: string | undefined
declare const __AUTH_TYPE__: "session" | "jwt" | undefined
declare const __JWT_TOKEN_STORAGE_KEY__: string | undefined
export const sdk = new Medusa({
 baseUrl: typeof __BACKEND_URL__ === "string" ? __BACKEND_URL__ : "/",
 auth: { type: typeof __AUTH_TYPE__ === "string" ? __AUTH_TYPE__ : "session",
 jwtTokenStorageKey: typeof __JWT_TOKEN_STORAGE_KEY__ === "string" ? __JWT_TOKEN_STORAGE_KEY__ : undefined }
})
