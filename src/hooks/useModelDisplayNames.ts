import { useEffect, useState } from 'react';

import { loadModelDisplayNames, onModelDisplayNamesChanged } from '../lib/modelCatalog';

/**
 * Kick off the models.dev display-name index load and re-render when it lands.
 *
 * `resolveModelDisplayName` is a synchronous read, so the first paint uses
 * prettified names and this hook is what makes the catalog's names replace
 * them. Mount it once near the app root; components that render model names
 * call it to stay in sync.
 */
export function useModelDisplayNames(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    void loadModelDisplayNames();
    return onModelDisplayNamesChanged(() => setVersion((value) => value + 1));
  }, []);
}
