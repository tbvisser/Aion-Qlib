import { useEffect, useRef, useState } from 'react'

export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (Array.from(dataTransfer.types).includes('Files')) return true
  if (dataTransfer.files.length > 0) return true
  return Array.from(dataTransfer.items).some(item => item.kind === 'file')
}

function isOutsideViewport(event: DragEvent): boolean {
  return (
    event.clientX <= 0 ||
    event.clientY <= 0 ||
    event.clientX >= window.innerWidth ||
    event.clientY >= window.innerHeight
  )
}

interface UseFileDropOptions {
  active?: boolean
  disabled?: boolean
  onDragEnter?: (event: DragEvent) => void
  onDragOver?: (event: DragEvent) => void
  onDragLeave?: (event: DragEvent) => void
  onEmptyDrop?: (event: DragEvent) => void
  onFiles: (files: File[], event: DragEvent) => void
}

export function useFileDrop({
  active = true,
  disabled = false,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onEmptyDrop,
  onFiles,
}: UseFileDropOptions) {
  const [draggingFiles, setDraggingFiles] = useState(false)
  const dragDepthRef = useRef(0)
  const callbacksRef = useRef({
    onDragEnter,
    onDragOver,
    onDragLeave,
    onEmptyDrop,
    onFiles,
  })

  callbacksRef.current = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onEmptyDrop,
    onFiles,
  }

  useEffect(() => {
    if (!active) {
      setDraggingFiles(false)
      dragDepthRef.current = 0
      return
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current += 1
      if (disabled) return
      setDraggingFiles(true)
      callbacksRef.current.onDragEnter?.(event)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      if (disabled) return
      setDraggingFiles(true)
      callbacksRef.current.onDragOver?.(event)
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (isOutsideViewport(event) || dragDepthRef.current === 0) {
        setDraggingFiles(false)
        if (!disabled) callbacksRef.current.onDragLeave?.(event)
      }
    }

    const handleDrop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setDraggingFiles(false)
      if (disabled) return

      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) {
        callbacksRef.current.onFiles(files, event)
      } else {
        callbacksRef.current.onEmptyDrop?.(event)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [active, disabled])

  return { draggingFiles }
}
