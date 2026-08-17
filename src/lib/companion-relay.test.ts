import { describe, expect, it } from 'vitest';

import { formatRelayEndpoint, isRelayEndpointValid, parseRelayEndpoint, buildRelayBaseUrl } from './companion-relay';

describe('companion-relay', () => {
  it('parses host:port endpoints', () => {
    expect(parseRelayEndpoint('relay.example.com:443')).toEqual({
      host: 'relay.example.com',
      port: '443',
    });
  });

  it('formats host and port', () => {
    expect(formatRelayEndpoint('relay.example.com', '443')).toBe('relay.example.com:443');
  });

  it('validates endpoint shape', () => {
    expect(isRelayEndpointValid('relay.example.com:443')).toBe(true);
    expect(isRelayEndpointValid('')).toBe(false);
    expect(isRelayEndpointValid('relay.example.com:0')).toBe(false);
  });

  it('builds relay base url', () => {
    expect(buildRelayBaseUrl('relay.fumi-blog.top:443', true)).toBe('https://relay.fumi-blog.top:443');
    expect(buildRelayBaseUrl('relay.example.com:8787', false)).toBe('http://relay.example.com:8787');
  });
});
