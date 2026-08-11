const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/x-png': 'png',
  'image/jpeg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function getSupportedImageExtension(file: File): string | null {
  const mimeExtension = IMAGE_EXTENSION_BY_MIME[file.type.toLowerCase()]
  if (mimeExtension) return mimeExtension

  const filenameExtension = file.name.split('.').pop()?.toLowerCase()
  if (filenameExtension && IMAGE_MIME_BY_EXTENSION[filenameExtension]) {
    return filenameExtension === 'jpeg' ? 'jpg' : filenameExtension
  }

  return null
}

function formatPasteTimestamp(date: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('')
}

function toPastedImageFile(file: File): File | null {
  const extension = getSupportedImageExtension(file)
  if (!extension) return null

  const contentType = file.type || IMAGE_MIME_BY_EXTENSION[extension] || 'image/png'
  const filename = `pasted-image-${formatPasteTimestamp(new Date())}.${extension}`
  return new File([file], filename, {
    type: contentType,
    lastModified: file.lastModified || Date.now(),
  })
}

export function getPastedImageFile(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) return null

  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    return toPastedImageFile(file)
  }

  for (const file of Array.from(clipboardData.files)) {
    if (!file.type.toLowerCase().startsWith('image/')) continue
    return toPastedImageFile(file)
  }

  return null
}
