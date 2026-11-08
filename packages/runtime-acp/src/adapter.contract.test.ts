import { fakeAcpPath, runAdapterContract } from '@uncage/testkit';
import { acpAdapter } from './index.js';

runAdapterContract('acp (fake agent)', () => acpAdapter({ id: 'acp-fake', displayName: 'Fake ACP', command: ['node', fakeAcpPath] }), {
  simple: 'simple',
  approval: 'approval',
  crash: 'crash',
});
