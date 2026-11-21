export function distanceMeters(lat, lng, centerLat, centerLng) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat - centerLat);
  const dLng = rad(lng - centerLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(centerLat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function validatePosition(position, config, now = Date.now()) {
  if (!position || !['latitude', 'longitude', 'accuracy', 'timestamp'].every(key => typeof position[key] === 'number' && Number.isFinite(position[key]))) {
    return { ok: false, message: 'A localização recebida é inválida. Verifique sua posição novamente.' };
  }
  const { latitude, longitude, accuracy, timestamp } = position;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || timestamp > now + 5000 || now - timestamp > 60000) {
    return { ok: false, message: 'A localização expirou ou é inválida. Verifique sua posição novamente.' };
  }
  if (accuracy > config.maxAccuracy) {
    return { ok: false, message: 'A precisão do GPS está baixa. Ative a localização precisa e tente em uma área aberta.' };
  }
  const distance = distanceMeters(latitude, longitude, config.lat, config.lng);
  if (distance + accuracy > config.radius) {
    return { ok: false, message: `Não foi possível confirmar sua presença dentro do raio de ${config.radius} metros. Aproxime-se do centro do evento e tente novamente.` };
  }
  return { ok: true };
}
