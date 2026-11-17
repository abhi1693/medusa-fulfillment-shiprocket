export type DocumentCheck = {
  available: boolean
  http_status?: number
  message: string
}
const allowed = (url: URL) =>
  url.protocol === "https:" &&
  !url.username &&
  !url.password &&
  (!url.port || url.port === "443") &&
  (/^sr-core-cdn(?:-stage)?\.kartrocket\.com$/i.test(url.hostname) ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(url.hostname) ||
    /(?:^|\.)cloudfront\.net$/i.test(url.hostname) ||
    /(?:^|\.)shiprocket\.in$/i.test(url.hostname))
/** Separate public fetch: the Shiprocket API bearer is never sent to a document origin. */
export async function checkDocument(
  value: string,
  timeout: number
): Promise<DocumentCheck> {
  try {
    let url = new URL(value)
    const signal = AbortSignal.timeout(timeout)
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!allowed(url))
        return {
          available: false,
          message:
            "Document origin is not a supported HTTPS carrier document host",
        }
      const response = await fetch(url, { redirect: "manual", signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        if (!location || redirects === 3)
          return {
            available: false,
            message: "Document redirect could not be verified",
          }
        url = new URL(location, url)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        return {
          available: false,
          http_status: response.status,
          message: `Carrier document download returned HTTP ${response.status}`,
        }
      }
      const reader = response.body?.getReader()
      if (!reader)
        return {
          available: false,
          http_status: response.status,
          message: "Carrier document is empty",
        }
      let prefix = Buffer.alloc(0)
      try {
        while (prefix.length < 5) {
          const part = await reader.read()
          if (part.done) break
          prefix = Buffer.concat([
            prefix,
            Buffer.from(part.value).subarray(0, 5 - prefix.length),
          ])
        }
      } finally {
        await reader.cancel()
      }
      const pdf = prefix.toString() === "%PDF-"
      return {
        available: pdf,
        http_status: response.status,
        message: pdf
          ? "PDF download verified"
          : "Carrier URL did not return a PDF",
      }
    }
  } catch {
    return {
      available: false,
      message: "Carrier document download could not be verified",
    }
  }
  return {
    available: false,
    message: "Carrier document download could not be verified",
  }
}
