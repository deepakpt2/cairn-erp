import { notFound } from 'next/navigation';

import {
  ActionRow, Button, Card, Chip, EmptyRow, Field, FormGrid, KeyValue, Notice, Page, Table, Td, Th,
} from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** Every kit component on one screen, for checking the look at phone and desktop width. Not served in production. */
export default function KitPage() {
  if (process.env.CAIRN_ENV === 'production') notFound();
  return (
    <Page title="UI kit" code="dev" description="Reference for the shared components in src/ui/kit.">
      <Card title="Buttons and chips" actions={<Button variant="primary">Save</Button>}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button>Default</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Small</Button>
          <Chip tone="ok">Posted</Chip><Chip tone="warn">Blocked</Chip>
          <Chip tone="error">Failed</Chip><Chip tone="info">Open</Chip><Chip>Draft</Chip>
        </div>
      </Card>
      <Card title="Messages">
        <div className="space-y-2">
          <Notice tone="ok" title="Order 4500001 saved.">Credit check passed.</Notice>
          <Notice tone="warn" title="Order blocked for credit." remedy="Release the block or lower the order value." />
          <Notice tone="error" title="Material not found." remedy="Check the material number." />
          <Notice tone="info" title="Prices are read from the condition record." />
        </div>
      </Card>
      <Card title="Form">
        <form className="space-y-3">
          <FormGrid>
            <Field label="Customer" htmlFor="k-c" hint="Customer number"><input id="k-c" className="field-input" /></Field>
            <Field label="Date" htmlFor="k-d"><input id="k-d" className="field-input" placeholder="YYYY-MM-DD" /></Field>
            <Field label="Currency" htmlFor="k-u" error="Required"><input id="k-u" className="field-input" /></Field>
          </FormGrid>
          <ActionRow>
            <Button variant="primary" type="submit">Save</Button>
            <Button>Cancel</Button>
          </ActionRow>
        </form>
      </Card>
      <Card title="Document header">
        <KeyValue items={[
          { label: 'Order', value: '4500001' }, { label: 'Customer', value: 'C-1001' },
          { label: 'Date', value: '2026-11-17' }, { label: 'Status', value: <Chip tone="ok">Open</Chip> },
        ]} />
      </Card>
      <Card title="Table" bodyClassName="p-0 sm:p-0">
        <Table caption="Example lines">
          <thead><tr><Th>Item</Th><Th>Material</Th><Th numeric>Quantity</Th><Th numeric>Value</Th><Th>Plant</Th><Th>Needed by</Th></tr></thead>
          <tbody>
            <tr><Td>10</Td><Td>FG-100</Td><Td numeric>12.000</Td><Td numeric>1,200.00</Td><Td>1000</Td><Td>2026-12-01</Td></tr>
            <tr><Td>20</Td><Td>FG-200</Td><Td numeric>3.000</Td><Td numeric>450.00</Td><Td>1000</Td><Td>2026-12-01</Td></tr>
            <EmptyRow cols={6} />
          </tbody>
        </Table>
      </Card>
    </Page>
  );
}
