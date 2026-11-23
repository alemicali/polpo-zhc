export function embeddedDocImage(src: string) {
  return /^data:image\/(png|jpe?g|gif|bmp|webp);base64,([a-z\d+/=]+)$/i.exec(src);
}
