/**
 * QR rendering for the scan-to-create link.
 *
 * The `qrcode` package is an optional runtime dependency: when it is missing the
 * settings page still gets the raw URL and can show it as a tappable link, which
 * is why this module never throws.
 */
export async function qrSvgDataUrl(text) {
  if (!text) return null
  try {
    const module = await import('qrcode')
    const QRCode = module.default ?? module
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      width: 260,
      errorCorrectionLevel: 'M',
    })
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  } catch {
    return null
  }
}
