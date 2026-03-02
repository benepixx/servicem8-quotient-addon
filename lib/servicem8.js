'use strict';

const https = require('https');
const FormData = require('form-data');

class ServiceM8 {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: 'api.servicem8.com',
        path: `/api_1.0${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };
      if (payload) {
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              console.error('ServiceM8 JSON parse error:', err.message, data);
              resolve({});
            }
          } else {
            reject(new Error(`ServiceM8 API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  getJob(uuid) {
    return this._request('GET', `/job/${uuid}.json`);
  }

  updateJob(uuid, data) {
    return this._request('POST', `/job/${uuid}.json`, data);
  }

  getCompany(uuid) {
    return this._request('GET', `/company/${uuid}.json`);
  }

  getJobAttachments(jobUUID) {
    return this._request('GET', `/attachment.json?$filter=related_object_uuid eq '${jobUUID}'`);
  }

  getJobMaterials(jobUUID) {
    return this._request('GET', `/jobmaterial.json?$filter=job_uuid eq '${jobUUID}'`);
  }

  addJobMaterial(jobUUID, lineItem) {
    return this._request('POST', '/jobmaterial.json', {
      job_uuid: jobUUID,
      name: lineItem.name || lineItem.description,
      quantity: lineItem.quantity || 1,
      unit_price: lineItem.unit_price || lineItem.unitPrice || 0,
      unit_cost: lineItem.unit_cost || lineItem.unitCost || 0,
      notes: lineItem.notes || '',
      is_billable: 1,
      material_type: lineItem.material_type || 'MATERIAL',
    });
  }

  deleteJobMaterial(materialUUID) {
    return this._request('DELETE', `/jobmaterial/${materialUUID}.json`);
  }

  attachFile(jobUUID, pdfBuffer, filename) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('related_object_uuid', jobUUID);
      form.append('related_object', 'job');
      form.append('file', pdfBuffer, { filename, contentType: 'application/pdf' });

      const options = {
        hostname: 'api.servicem8.com',
        path: '/api_1.0/attachment.json',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...form.getHeaders(),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              console.error('ServiceM8 attachFile JSON parse error:', err.message, data);
              resolve({});
            }
          } else {
            reject(new Error(`ServiceM8 attachFile error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      form.pipe(req);
    });
  }

  setJobQueue(jobUUID, queueUUID) {
    return this._request('POST', `/job/${jobUUID}.json`, { queue_uuid: queueUUID });
  }
}

module.exports = ServiceM8;
