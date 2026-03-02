'use strict';

// Queue UUIDs — set these via environment variables or update to match your ServiceM8 account
const PARTS_TO_ORDER_QUEUE_UUID = process.env.SM8_PARTS_TO_ORDER_QUEUE_UUID || '';
const READY_TO_BOOK_QUEUE_UUID = process.env.SM8_READY_TO_BOOK_QUEUE_UUID || '';

class JobQueue {
  constructor(sm8Client) {
    this.sm8 = sm8Client;
  }

  /**
   * Sync accepted quote line items to SM8 billing and route job to the correct queue.
   * @param {string} jobUUID
   * @param {Object} quote - Quotient quote object with lineItems array
   * @returns {Promise<{ lineItems: Array, queueName: string }>}
   */
  async processAcceptedQuote(jobUUID, quote) {
    // Replace all existing billing lines with the accepted quote's line items
    const existing = await this.sm8.getJobMaterials(jobUUID);
    const deleteResults = await Promise.allSettled(
      (existing || []).map((m) => this.sm8.deleteJobMaterial(m.uuid))
    );
    deleteResults
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.error('Failed to delete job material:', r.reason));

    const lineItems = quote.lineItems || [];
    const addResults = await Promise.allSettled(
      lineItems.map((item) =>
        this.sm8.addJobMaterial(jobUUID, {
          name: item.description || item.name,
          quantity: item.quantity || 1,
          unit_price: item.unit_price || item.unitPrice || 0,
          unit_cost: item.unit_cost || item.unitCost || 0,
          notes: item.notes || '',
          material_type: 'MATERIAL',
        })
      )
    );
    addResults
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.error('Failed to add job material:', r.reason));

    // Determine target queue: if any line item needs parts (unit_cost > 0 or explicit flag),
    // route to "Parts to Order"; otherwise "Ready to Book"
    const needsParts = lineItems.some(
      (item) => (item.unit_cost || item.unitCost || 0) > 0
    );

    const queueUUID = needsParts ? PARTS_TO_ORDER_QUEUE_UUID : READY_TO_BOOK_QUEUE_UUID;
    const queueName = needsParts ? 'Parts to Order' : 'Ready to Book';

    if (queueUUID) {
      await this.sm8.setJobQueue(jobUUID, queueUUID);
    }

    return { lineItems, queueName };
  }
}

module.exports = JobQueue;
