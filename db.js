const sql = require('mssql');
const fs = require('fs/promises');
const path = require('path');
const { existsSync, readdirSync } = require('fs');

class MSSQL {
    constructor(config = {}) {
        this.config = config;
        this.pool = null;
    }

    async connect(connectionStringOrConfig = this.config) {
        try {
            const config = typeof connectionStringOrConfig === 'string'
                ? { connectionString: connectionStringOrConfig }
                : connectionStringOrConfig;

            const poolConfig = {
                ...config,
                options: {
                    encrypt: true,
                    trustServerCertificate: false,
                    ...(config.options || {})
                }
            };

            this.pool = await sql.connect(poolConfig);
            console.log('Connected to MSSQL');
            return this.pool;
        } catch (err) {
            console.error('Error connecting to MSSQL:', err);
            throw err;
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }

    async query(queryText, params = {}) {
        if (!this.pool) {
            await this.connect();
        }

        try {
            const request = this.pool.request();
            const normalizedParams = { ...params };
            const preparedQuery = this.prepareQueryWithDefaults(queryText);

            if (!normalizedParams.AsOfDate) {
                normalizedParams.AsOfDate = new Date();
            }
            if (!normalizedParams.EndDate) {
                normalizedParams.EndDate = new Date();
            }
            if (!normalizedParams.StartDate) {
                normalizedParams.StartDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
            }

            Object.entries(normalizedParams).forEach(([name, value]) => {
                request.input(name, value);
            });

            const result = await request.query(preparedQuery);
            return result;
        } catch (err) {
            console.error('Error executing query:', err);
            throw err;
        }
    }

    async readFileAsync(file) {
        const raw = await fs.readFile(file, 'utf8');
        return JSON.parse(raw);
    }

    async buildDefinitionsFromFolder(folderPath) {
        if (!existsSync(folderPath)) {
            return [];
        }

        const entries = [];
        const files = readdirSync(folderPath)
            .filter((name) => name.toLowerCase().endsWith('.sql'))
            .sort();

        for (const name of files) {
            const fullPath = path.join(folderPath, name);
            const queryText = await fs.readFile(fullPath, 'utf8');
            const queries = this.extractQueriesFromScript(queryText);

            if (queries.length > 0) {
                entries.push({
                    name: name.replace(/\.sql$/i, ''),
                    query: queries.length === 1 ? queries[0] : queries,
                    sourceFile: fullPath
                });
            }
        }

        return entries;
    }

    extractQueriesFromScript(scriptText) {
        const cleaned = scriptText
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/--.*$/gm, ' ')
            .replace(/\r/g, '')
            .trim();

        if (!cleaned) {
            return [];
        }

        const statements = cleaned
            .split(/;|\bGO\b/i)
            .map((value) => value.trim())
            .filter(Boolean);

        const queries = [];
        const setupStatements = [];

        for (const statement of statements) {
            const normalized = statement.replace(/\s+/g, ' ').trim();
            if (!normalized) {
                continue;
            }

            const queryIndex = normalized.search(/\b(?:WITH|SELECT)\b/i);
            if (queryIndex >= 0) {
                const setupText = normalized.slice(0, queryIndex).trim();
                const queryText = normalized.slice(queryIndex).trim();
                if (setupText) {
                    const firstWord = setupText.split(' ')[0].toUpperCase();
                    if (firstWord === 'USE' || firstWord === 'SET' || /^DECLARE\b/i.test(setupText)) {
                        setupStatements.push(setupText);
                    }
                }

                const analysis = this.analyzeQuery(queryText);
                if (analysis.valid) {
                    queries.push(this.prepareQueryWithDefaults(queryText, setupStatements));
                }
                continue;
            }

            const firstWord = normalized.split(' ')[0].toUpperCase();
            if (firstWord === 'USE' || firstWord === 'SET' || /^DECLARE\b/i.test(normalized)) {
                setupStatements.push(normalized);
                continue;
            }

            const analysis = this.analyzeQuery(normalized);
            if (analysis.valid) {
                queries.push(this.prepareQueryWithDefaults(normalized, setupStatements));
            }
        }

        return queries;
    }

    prepareQueryWithDefaults(queryText, setupStatements = []) {
        if (typeof queryText !== 'string' || !queryText.trim()) {
            return queryText;
        }

        const baseLines = [];
        for (const setup of setupStatements || []) {
            if (/^DECLARE\b/i.test(setup)) {
                baseLines.push(`-- ${setup}`);
            } else {
                baseLines.push(setup);
            }
        }

        const trimmed = queryText.trim();
        const commented = trimmed
            .split('\n')
            .map((line) => {
                if (/^\s*DECLARE\s+@(?:AsOfDate|EndDate|StartDate)\b/i.test(line)) {
                    return `-- ${line.trim()}`;
                }
                return line;
            })
            .join('\n')
            .trim();

        const needsDefaults = /\b@(?:AsOfDate|EndDate|StartDate)\b/i.test(commented);

        if (!needsDefaults) {
            return [...baseLines, commented].filter(Boolean).join('\n');
        }

        return [
            ...baseLines,
            'DECLARE @AsOfDate date = CAST(GETDATE() AS date);',
            'DECLARE @EndDate date = CAST(GETDATE() AS date);',
            'DECLARE @StartDate date = DATEADD(day, -14, GETDATE());',
            commented
        ].filter(Boolean).join('\n');
    }

    analyzeQuery(queryText) {
        const cleaned = queryText
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/--.*$/gm, ' ')
            .replace(/\r/g, ' ')
            .trim();

        const statements = cleaned
            .split(/;|\bGO\b/i)
            .map((value) => value.trim())
            .filter(Boolean);

        let queryCount = 0;

        for (const statement of statements) {
            const normalized = statement.replace(/\s+/g, ' ').trim();
            if (!normalized) {
                continue;
            }

            const firstWord = normalized.split(' ')[0].toUpperCase();
            if (firstWord === 'GO') {
                continue;
            }

            if (/\b(?:EXEC|sp_executesql|xp_|sp_)\b/i.test(normalized)) {
                return { valid: false, error: 'Dynamic SQL is not allowed.' };
            }

            if (/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|MERGE|CREATE)\b/i.test(normalized)) {
                return { valid: false, error: 'Only SELECT statements are allowed.' };
            }

            if (/\b(?:OPENROWSET|OPENQUERY)\b/i.test(normalized)) {
                return { valid: false, error: 'External rowset access is not allowed.' };
            }

            if (firstWord === 'USE' || firstWord === 'SET') {
                continue;
            }

            if (/^DECLARE\b/i.test(normalized)) {
                continue;
            }

            if (/^WITH\b/i.test(normalized) || /^SELECT\b/i.test(normalized)) {
                queryCount += 1;
                if (queryCount > 1) {
                    return { valid: false, error: 'Only a single statement is allowed.' };
                }
                continue;
            }

            if (/^\(\s*SELECT\b/i.test(normalized)) {
                queryCount += 1;
                continue;
            }

            if (/^WITH\s+\w+\s+AS\b/i.test(normalized) || /^SELECT\b/i.test(normalized)) {
                queryCount += 1;
                continue;
            }

            return { valid: false, error: 'Only SELECT statements are allowed.' };
        }

        return { valid: queryCount === 1, error: queryCount === 1 ? null : 'Only SELECT statements are allowed.' };
    }

    isScriptSafe(scriptText) {
        return this.analyzeQuery(scriptText).valid;
    }

    validateQuery(queryText) {
        const queries = Array.isArray(queryText) ? queryText : [queryText];

        queries.forEach((entry) => {
            if (typeof entry !== 'string' || !entry.trim()) {
                throw new Error('Query must be a non-empty string.');
            }

            const analysis = this.analyzeQuery(entry);
            if (!analysis.valid) {
                throw new Error(analysis.error || 'Query script contains unsupported or unsafe statements.');
            }
        });

        return true;
    }

    sanitizeWorksheetName(name) {
        const base = String(name || '').trim() || 'Sheet1';
        const sanitized = base
            .replace(/[\\/?*\[\]:]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/_+/g, '_')
            .trim();

        return sanitized.substring(0, 31);
    }

    buildWorkbookFileName(prefix = 'KPIReport') {
        const date = new Date();
        const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        return `${prefix}_${stamp}.xlsx`;
    }

    async generateWorkbook(reports, outputPath) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();

        for (const report of reports) {
            const queries = Array.isArray(report.query)
                ? report.query
                : [report.query];

            if (!queries.length || !queries.some(Boolean)) {
                throw new Error(`Report ${report.name || 'Unnamed'} has no query.`);
            }

            this.validateQuery(queries);

            const worksheet = workbook.addWorksheet(this.sanitizeWorksheetName(report.name));
            const combinedRows = [];

            for (const queryText of queries) {
                const result = await this.query(queryText, {
                    AsOfDate: new Date(),
                    EndDate: new Date(),
                    StartDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
                });
                const rows = result.recordset || [];
                combinedRows.push(...rows);
            }

            if (combinedRows.length > 0) {
                const headers = Object.keys(combinedRows[0]);
                worksheet.columns = headers.map((header) => ({
                    header,
                    key: header,
                    width: Math.max(header.length, 20)
                }));
                worksheet.addRows(combinedRows);
            } else {
                worksheet.columns = [{ header: 'No data', key: 'No data', width: 20 }];
                worksheet.addRow({ 'No data': 'No rows returned' });
            }

            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
            worksheet.autoFilter = {
                from: 'A1',
                to: worksheet.lastColumn ? `${worksheet.lastColumn.letter}${worksheet.rowCount}` : 'A1'
            };
        }

        await workbook.xlsx.writeFile(outputPath);
        return outputPath;
    }

    async runReports(definitionsFile, outputFile) {
        let reports = [];
        let resolvedOutput = outputFile || path.join(path.dirname(definitionsFile), this.buildWorkbookFileName());

        if (definitionsFile && existsSync(definitionsFile)) {
            try {
                const definitions = await this.readFileAsync(definitionsFile);
                reports = Array.isArray(definitions) ? definitions : definitions.reports || [];
            } catch (error) {
                reports = [];
            }
        }

        if (!reports.length) {
            const folderPath = path.join(path.dirname(definitionsFile || __dirname), 'SQL');
            reports = await this.buildDefinitionsFromFolder(folderPath);
        }

        if (!reports.length) {
            throw new Error('No report definitions were found.');
        }

        await this.generateWorkbook(reports, resolvedOutput);
        return resolvedOutput;
    }
}

module.exports = MSSQL;

