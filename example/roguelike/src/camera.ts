export interface CameraOriginInput {
  mapWidth: number
  mapHeight: number
  viewWidth: number
  viewHeight: number
  playerX: number
  playerY: number
}

export interface CameraOrigin {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function cameraOrigin(input: CameraOriginInput): CameraOrigin {
  const maxX = Math.max(0, input.mapWidth - input.viewWidth)
  const maxY = Math.max(0, input.mapHeight - input.viewHeight)
  return {
    x: clamp(input.playerX - Math.floor(input.viewWidth / 2), 0, maxX),
    y: clamp(input.playerY - Math.floor(input.viewHeight / 2), 0, maxY),
  }
}
