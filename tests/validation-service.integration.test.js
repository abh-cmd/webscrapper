const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let validationService;
let productRepo;
if (isDatabaseConfigured()) {
  validationService = require('../src/validation/validation-service');
  productRepo = require('../src/db/product-repository');
}

const TEST_ITEM = 'WO-VALIDATION-TEST-00001';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM product_validation_exceptions WHERE item_number = $1;', [TEST_ITEM]);
  await productRepo?.deleteProductByItemNumber(TEST_ITEM);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('Objective 1: running validation against an existing product with a real inconsistency produces an exception with a confidence score', { skip }, async () => {
  await productRepo.upsertProduct({
    item_number: TEST_ITEM,
    item_name: 'Inconsistent Wine',
    product_name: 'Inconsistent Wine',
    category: 'White Wine', // deliberately wrong for the varietal below
    varietal: 'Cabernet Sauvignon',
    color: 'Pale straw yellow',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/validation-test/1',
    scraped_at: new Date().toISOString()
  });

  const created = await validationService.runValidation({ itemNumbers: [TEST_ITEM] });
  assert.ok(created.length >= 1);

  const colorFinding = created.find((f) => f.fieldName === 'color');
  assert.ok(colorFinding);
  assert.equal(colorFinding.status, 'pending_review');
  assert.ok(colorFinding.confidence > 0 && colorFinding.confidence <= 100);
  assert.equal(colorFinding.provider, 'deterministic-test');
});

test('running validation again does not duplicate an already-pending finding', { skip }, async () => {
  const before = await validationService.listExceptions({ itemNumber: TEST_ITEM, status: 'pending_review' });
  const createdAgain = await validationService.runValidation({ itemNumbers: [TEST_ITEM] });
  assert.equal(createdAgain.length, 0, 'a second run must not create duplicate pending findings');
  const after = await validationService.listExceptions({ itemNumber: TEST_ITEM, status: 'pending_review' });
  assert.equal(after.length, before.length);
});

test('approving an exception applies exactly the suggested value to the named field, nothing else', { skip }, async () => {
  // This product trips both the color check and the category check (see
  // the setup above: category="White Wine" + varietal="Cabernet
  // Sauvignon"), so there are two pending findings — filter to the one
  // this test actually exercises rather than assume array position/order.
  const pending = await validationService.listExceptions({ itemNumber: TEST_ITEM, status: 'pending_review' });
  const colorFinding = pending.find((f) => f.fieldName === 'color');
  assert.ok(colorFinding);
  const beforeUpdate = await productRepo.getProductByItemNumber(TEST_ITEM);

  const approved = await validationService.approveException(colorFinding.id, { reviewer: 'validation-reviewer@example.com' });
  assert.equal(approved.status, 'approved');

  const afterUpdate = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.equal(afterUpdate.color, colorFinding.suggestedValue);
  // Nothing else about the product changed.
  assert.equal(afterUpdate.varietal, beforeUpdate.varietal);
  assert.equal(afterUpdate.category, beforeUpdate.category);
});

test('rejecting an exception leaves the product completely untouched', { skip }, async () => {
  await productRepo.upsertProduct({
    item_number: `${TEST_ITEM}-reject`,
    item_name: 'Reject Test Wine',
    category: 'White Wine',
    varietal: 'Merlot',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/validation-test/2',
    scraped_at: new Date().toISOString()
  });
  const created = await validationService.runValidation({ itemNumbers: [`${TEST_ITEM}-reject`] });
  const finding = created[0];
  const before = await productRepo.getProductByItemNumber(`${TEST_ITEM}-reject`);

  await validationService.rejectException(finding.id, { reviewer: 'validation-reviewer@example.com' });

  const after = await productRepo.getProductByItemNumber(`${TEST_ITEM}-reject`);
  assert.deepEqual(after, before);

  const pool = getPool();
  await pool.query('DELETE FROM product_validation_exceptions WHERE item_number = $1;', [`${TEST_ITEM}-reject`]);
  await productRepo.deleteProductByItemNumber(`${TEST_ITEM}-reject`);
});

test('a consistent product produces no findings — the validator never fabricates issues', { skip }, async () => {
  await productRepo.upsertProduct({
    item_number: `${TEST_ITEM}-clean`,
    item_name: 'Clean Wine',
    category: 'Red Wine',
    varietal: 'Merlot',
    color: 'Deep ruby red',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/validation-test/3',
    scraped_at: new Date().toISOString()
  });
  const created = await validationService.runValidation({ itemNumbers: [`${TEST_ITEM}-clean`] });
  assert.deepEqual(created, []);

  await productRepo.deleteProductByItemNumber(`${TEST_ITEM}-clean`);
});

test('an exception cannot be approved to overwrite the primary key or provenance fields', { skip }, async () => {
  const pool = getPool();
  const badFinding = await pool.query(
    `INSERT INTO product_validation_exceptions (item_number, field_name, current_value, suggested_value, confidence, reason, provider)
     VALUES ($1, 'item_number', $1, 'WO-HACKED', 99, 'test', 'deterministic-test') RETURNING id;`,
    [TEST_ITEM]
  );
  await assert.rejects(() => validationService.approveException(badFinding.rows[0].id, { reviewer: 'x' }));
  await pool.query('DELETE FROM product_validation_exceptions WHERE id = $1;', [badFinding.rows[0].id]);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
