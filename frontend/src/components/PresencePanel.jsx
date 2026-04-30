import React from 'react';
import { colorFor } from '../utils/colors';

export function PresencePanel({ users, you }) {
  return (
    <div style={{
      padding: '8px 12px', borderBottom: '1px solid #333',
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 12, color: '#999' }}>Active:</span>
      {users.map(u => (
        <span key={u} style={{
          fontSize: 12,
          padding: '2px 8px',
          borderRadius: 12,
          background: colorFor(u),
          color: 'white',
          fontWeight: u === you ? 700 : 400,
        }}>
          {u}{u === you ? ' (you)' : ''}
        </span>
      ))}
    </div>
  );
}
