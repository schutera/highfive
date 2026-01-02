export type Module = {
  id: string;
  name: string;
  location: [number, number]; // [lat, lng]
  status: 'online' | 'offline';
};

// Bee species configuration with consistent colors across the application
export const BEE_TYPES = [
  { key: 'blackmasked', name: 'Black Masked Bee', size: '2mm', color: '#f59e0b', lightColor: '#fef3c7' },
  { key: 'resin', name: 'Resin Bee', size: '3mm', color: '#eab308', lightColor: '#fef9c3' },
  { key: 'leafcutter', name: 'Leafcutter Bee', size: '6mm', color: '#84cc16', lightColor: '#ecfccb' },
  { key: 'orchard', name: 'Orchard Bee', size: '9mm', color: '#22c55e', lightColor: '#dcfce7' },
] as const;

export type BeeTypeKey = typeof BEE_TYPES[number]['key'];
