// Stable, perceptually-distinct color from a userId string.
// Same userId always gets same hue across all clients — important so that
// "the green cursor" means the same person to everyone in the room.
export function colorFor(userId) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 70%, 50%)`;
}
