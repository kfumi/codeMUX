import { describe, expect, it } from 'vitest';
import { extractErrorText, formatErrorMessage } from './errorMessage';

describe('extractErrorText', () => {
  it('unwraps the daemon {"error": ...} envelope', () => {
    expect(extractErrorText('{"error":"当前项目不是 Git 仓库"}', 'fallback')).toBe('当前项目不是 Git 仓库');
  });

  it('unwraps message / msg keys', () => {
    expect(extractErrorText('{"message":"boom"}', 'fallback')).toBe('boom');
    expect(extractErrorText('{"msg":"boom"}', 'fallback')).toBe('boom');
  });

  it('unwraps a nested error object', () => {
    expect(extractErrorText('{"error":{"message":"nested boom"}}', 'fallback')).toBe('nested boom');
  });

  it('returns non-JSON bodies verbatim', () => {
    expect(extractErrorText('  plain failure  ', 'fallback')).toBe('plain failure');
  });

  it('falls back for empty bodies', () => {
    expect(extractErrorText('   ', 'Daemon request failed: 500')).toBe('Daemon request failed: 500');
  });

  it('returns the body when the envelope has no readable field', () => {
    expect(extractErrorText('{"code":500}', 'fallback')).toBe('{"code":500}');
  });
});

describe('formatErrorMessage', () => {
  it('drops the Error: prefix and unwraps a JSON envelope inside message', () => {
    expect(formatErrorMessage(new Error('{"error":"当前项目不是 Git 仓库"}'))).toBe('当前项目不是 Git 仓库');
  });

  it('keeps a plain Error message as is', () => {
    expect(formatErrorMessage(new Error('连接失败'))).toBe('连接失败');
  });

  it('unwraps a rejected JSON string', () => {
    expect(formatErrorMessage('{"error":"not a git repo"}')).toBe('not a git repo');
  });

  it('keeps a rejected plain string', () => {
    expect(formatErrorMessage('当前项目不是 Git 仓库')).toBe('当前项目不是 Git 仓库');
  });

  it('uses the fallback for nullish values', () => {
    expect(formatErrorMessage(null, '加载失败')).toBe('加载失败');
    expect(formatErrorMessage(undefined, '加载失败')).toBe('加载失败');
    expect(formatErrorMessage(new Error(''), '加载失败')).toBe('加载失败');
  });

  it('stringifies other thrown values', () => {
    expect(formatErrorMessage(42)).toBe('42');
  });
});
