import { isNative } from './native.js';

export async function takeNativePhoto() {
  if (!isNative) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  const image = await Camera.getPhoto({
    quality: 90,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
    correctOrientation: true,
  });
  return { dataUrl: image.dataUrl };
}

export async function pickNativePhoto() {
  if (!isNative) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  const image = await Camera.getPhoto({
    quality: 90,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Photos,
    correctOrientation: true,
  });
  return { dataUrl: image.dataUrl };
}
