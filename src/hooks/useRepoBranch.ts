import { useEffect, useState } from 'react';

import { daemonFacade } from '../lib/facades/daemon-facade';

interface BranchCacheEntry {
  branch: string | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;

const branchCache = new Map<string, BranchCacheEntry>();
const inflightRequests = new Map<string, Promise<string | null>>();

async function readBranch(workingPath: string): Promise<string | null> {
  const cached = branchCache.get(workingPath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  const inflight = inflightRequests.get(workingPath);
  if (inflight) {
    return inflight;
  }

  const request = daemonFacade.git
    .getRepositoryState(workingPath)
    .then((state) => state.currentBranch ?? null)
    .catch(() => null)
    .then((branch) => {
      branchCache.set(workingPath, { branch, expiresAt: Date.now() + CACHE_TTL_MS });
      inflightRequests.delete(workingPath);
      return branch;
    });

  inflightRequests.set(workingPath, request);
  return request;
}

export function useRepoBranch(workingPath: string | null | undefined): {
  branch: string | null;
  loading: boolean;
} {
  const path = workingPath?.trim() || null;
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setBranch(null);
      setLoading(false);
      return;
    }

    const cached = branchCache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      setBranch(cached.branch);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void readBranch(path).then((value) => {
      if (cancelled) {
        return;
      }
      setBranch(value);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [path]);

  return { branch, loading };
}

export function resetRepoBranchCache(): void {
  branchCache.clear();
  inflightRequests.clear();
}
