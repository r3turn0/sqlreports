const test = require('node:test');
const assert = require('node:assert/strict');
const MSSQL = require('../db');

test('validates simple select queries', () => {
  const client = new MSSQL();
  assert.doesNotThrow(() => client.validateQuery('SELECT * FROM dbo.SalesSummary'));
  assert.throws(() => client.validateQuery('DELETE FROM dbo.SalesSummary'), /Only SELECT/i);
});

test('rejects multiple statements and dynamic SQL', () => {
  const client = new MSSQL();
  assert.throws(() => client.validateQuery('SELECT * FROM A; SELECT * FROM B'), /single statement/i);
  assert.throws(() => client.validateQuery('EXEC sp_executesql N\'SELECT 1\''), /Dynamic SQL/i);
});

test('sanitizes worksheet names and builds file names', () => {
  const client = new MSSQL();
  assert.equal(client.sanitizeWorksheetName('Sales/Report:Test[1]?'), 'Sales_Report_Test_1_');
  assert.match(client.buildWorkbookFileName('KPIReport'), /^KPIReport_\d{8}\.xlsx$/);
});

test('builds definitions from SQL files in a folder', async () => {
  const client = new MSSQL();
  const definitions = await client.buildDefinitionsFromFolder('./SQL');
  assert.ok(Array.isArray(definitions));
  assert.ok(definitions.length >= 0);
});
