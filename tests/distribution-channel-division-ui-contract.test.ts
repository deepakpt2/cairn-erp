import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const channelPage = readFileSync('src/app/config/distribution-channels/page.tsx', 'utf8');
const channelActions = readFileSync('src/app/config/distribution-channels/actions.ts', 'utf8');
const channelForm = readFileSync('src/app/config/distribution-channels/DistributionChannelDefinitionForm.tsx', 'utf8');
const channelDeactivate = readFileSync('src/app/config/distribution-channels/DeactivateDistributionChannelForm.tsx', 'utf8');
const divisionPage = readFileSync('src/app/config/divisions/page.tsx', 'utf8');
const divisionActions = readFileSync('src/app/config/divisions/actions.ts', 'utf8');
const divisionForm = readFileSync('src/app/config/divisions/DivisionDefinitionForm.tsx', 'utf8');
const divisionDeactivate = readFileSync('src/app/config/divisions/DeactivateDivisionForm.tsx', 'utf8');
const service = readFileSync('src/modules/foundation/distribution-channel-division-maintenance.ts', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
const appSources = [channelPage, channelActions, channelForm, channelDeactivate, divisionPage, divisionActions, divisionForm, divisionDeactivate, service, i18n].join('\n');

describe('SCR-022 Distribution Channel and Division UI/action contract', () => {
  it('keeps the two pages on separate exact capabilities and session-derived tenant/actor', () => {
    expect(channelPage).toContain("const ACTIVITY = 'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(channelPage).toContain('can(session, ACTIVITY)');
    expect(channelActions).toContain("const ACTIVITY = 'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(channelActions).toContain('await requireCapability(ACTIVITY, session)');
    expect(divisionPage).toContain("const ACTIVITY = 'CFG.ORG.DIVISION.DEFINE'");
    expect(divisionPage).toContain('can(session, ACTIVITY)');
    expect(divisionActions).toContain("const ACTIVITY = 'CFG.ORG.DIVISION.DEFINE'");
    expect(divisionActions).toContain('await requireCapability(ACTIVITY, session)');
    for (const action of [channelActions, divisionActions]) {
      expect(action).toContain('client: session.user.client');
      expect(action).toContain('changedBy: session.user.username');
      expect(action).not.toMatch(/form\.get\(['"](?:client|changedBy)['"]\)/);
    }
  });

  it('uses Cairn-native labels and identifiers and keeps source field codes out of app sources', () => {
    expect(i18n).toContain("'distributionChannel.code': 'Distribution Channel'");
    expect(i18n).toContain("'division.code': 'Division'");
    expect(i18n).toContain("'orgDefinition.name': 'Name'");
    expect(appSources).not.toMatch(/\b(?:VKORG|BUKRS|VTWEG|VTEXT|SPART)\b/i);
  });

  it('renders only the owner-approved two-character key and 20-character name fields', () => {
    for (const [form, keyName] of [[channelForm, 'distributionChannel'], [divisionForm, 'division']] as const) {
      expect(form).toContain(`name="${keyName}"`);
      expect(form).toContain('minLength={2}');
      expect(form).toContain('maxLength={2}');
      expect(form).toContain('pattern="[A-Za-z0-9]{2}"');
      expect(form).toContain('name="name"');
      expect(form).toContain('maxLength={20}');
      expect(form).toContain('required');
      expect(form).toContain('readOnly');
    }
  });

  it('limits copy to a new key and keeps deactivation separately confirmed', () => {
    expect(channelPage).toContain("{ distributionChannel: '', name: copySource?.name ?? '' }");
    expect(divisionPage).toContain("{ division: '', name: copySource?.name ?? '' }");
    expect(channelDeactivate).toContain('<details');
    expect(channelDeactivate).toContain('deactivateDistributionChannelAction');
    expect(divisionDeactivate).toContain('<details');
    expect(divisionDeactivate).toContain('deactivateDivisionAction');
    expect(service).toContain('async function hasSalesAreaReference');
    expect(service).toContain("Retain the definition while any Sales Area uses it.");
  });

  it('shows the inactive-retained notice once for authorized users and retains it for viewers', () => {
    expect(channelPage).toContain('{!selected.isActive && !canMaintain &&');
    expect(divisionPage).toContain('{!selected.isActive && !canMaintain &&');
    expect(channelDeactivate).toContain('if (!isActive)');
    expect(divisionDeactivate).toContain('if (!isActive)');
  });

  it('keeps list grids contained and the primary maintenance flow operable at phone width', () => {
    for (const page of [channelPage, divisionPage]) {
      expect(page).toContain('px-3 py-4 sm:p-6');
      expect(page).toContain('sm:hidden');
      expect(page).toContain('overflow-x-auto sm:block');
      expect(page).toContain('min-h-11');
    }
  });
});
