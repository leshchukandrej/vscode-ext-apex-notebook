import * as vscode from 'vscode';

/**
 * Interface for the log analysis result
 */
export interface LogAnalysis {
    summary: {
        totalTimeMs: number;
        dbTimeMs: number;
        heapSize: number;
        numDmlStatements: number;
        numSoqlQueries: number;
        numDatabaseCalls: number;
    };
    debugLines: { lineNumber: number; message: string; timestamp: string }[];
    timeline: { event: string; timeMs: number; details?: string }[];
    errors: { message: string; lineNumber?: number; columnNumber?: number; stackTrace?: string }[];
    limits: {
        name: string;
        used: number;
        total: number;
        percentage: number;
    }[];
    governorLimits: {
        name: string;
        usage: number;
        total: number;
    }[];
    methodCalls: {
        name: string;
        totalTimeMs: number;
        selfTimeMs: number;
        calls: number;
        parent?: string;
        children?: string[];
    }[];
    codeCoverage?: {
        coveragePercentage: number;
        linesCovered: number;
        linesTotal: number;
        uncoveredLines: number[];
    };
    hasCoverageInfo: boolean;
    totalExecutionTimeMs: number;
}

export class LogAnalyzerHandler {
    /**
     * Analyzes an Apex execution log and extracts useful information
     */
    public static analyzeApexLog(log: string): LogAnalysis {
        const analysis: LogAnalysis = {
            summary: {
                totalTimeMs: 0,
                dbTimeMs: 0,
                heapSize: 0,
                numDmlStatements: 0,
                numSoqlQueries: 0,
                numDatabaseCalls: 0
            },
            debugLines: [],
            timeline: [],
            errors: [],
            limits: [],
            governorLimits: [],
            methodCalls: [],
            hasCoverageInfo: false,
            totalExecutionTimeMs: 0
        };
        
        const lines = log.split('\n');
        let startTime = 0;
        let endTime = 0;
        
        // Track limits
        const limitMap = new Map<string, { used: number; total: number }>();
        
        // Process each line of the log
        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                // Parse the log line
                const parts = line.split('|');
                if (parts.length < 2) continue;
                
                const timestamp = parts[0];
                const eventType = parts[1];
                
                // Get the current time in seconds
                const currentTime = parseFloat(timestamp);
                
                // Calculate relative time from the start in milliseconds
                const relativeTimeMs = Math.round((currentTime - startTime) * 1000);
                
                // Process based on the event type
                if (eventType.includes('EXECUTION_STARTED')) {
                    startTime = currentTime;
                    analysis.timeline.push({ event: 'Execution Started', timeMs: 0 });
                } 
                else if (eventType.includes('EXECUTION_FINISHED')) {
                    endTime = currentTime;
                    analysis.totalExecutionTimeMs = Math.round((endTime - startTime) * 1000);
                    analysis.summary.totalTimeMs = analysis.totalExecutionTimeMs;
                    analysis.timeline.push({ event: 'Execution Finished', timeMs: analysis.totalExecutionTimeMs });
                }
                else if (eventType.includes('SOQL_EXECUTE_BEGIN')) {
                    analysis.summary.numSoqlQueries++;
                    const queryDetails = parts.slice(2).join('|').trim();
                    analysis.timeline.push({ 
                        event: 'SOQL Query', 
                        timeMs: relativeTimeMs,
                        details: queryDetails
                    });
                }
                else if (eventType.includes('DML_BEGIN')) {
                    analysis.summary.numDmlStatements++;
                    analysis.timeline.push({ 
                        event: 'DML Operation', 
                        timeMs: relativeTimeMs,
                        details: parts.slice(2).join('|').trim()
                    });
                }
                else if (eventType.includes('USER_DEBUG')) {
                    const lineMatch = parts[2].match(/\[(\d+)\]/);
                    const lineNumber = lineMatch ? parseInt(lineMatch[1]) : 0;
                    const message = parts.slice(3).join('|').trim();
                    
                    analysis.debugLines.push({ 
                        lineNumber, 
                        message, 
                        timestamp 
                    });
                    
                    analysis.timeline.push({ 
                        event: 'Debug Log', 
                        timeMs: relativeTimeMs,
                        details: `Line ${lineNumber}: ${message}`
                    });
                }
                else if (eventType.includes('HEAP_ALLOCATE')) {
                    const heapMatch = line.match(/Bytes:(\d+)/);
                    if (heapMatch) {
                        const heapSize = parseInt(heapMatch[1]);
                        if (heapSize > analysis.summary.heapSize) {
                            analysis.summary.heapSize = heapSize;
                        }
                    }
                }
                else if (eventType.includes('EXCEPTION_THROWN') || eventType.includes('FATAL_ERROR')) {
                    analysis.errors.push({ 
                        message: parts.slice(2).join('|').trim() 
                    });
                    
                    analysis.timeline.push({ 
                        event: 'Error', 
                        timeMs: relativeTimeMs,
                        details: parts.slice(2).join('|').trim()
                    });
                }
                else if (eventType.includes('LIMIT_USAGE') || eventType.includes('LIMIT_USAGE_FOR_NS')) {
                    const limitContent = parts.slice(2).join('|');
                    // Format is typically: "Number of SOQL queries: 3 out of 100"
                    const limitMatch = limitContent.match(/([^:]+):\s+(\d+)\s+out of\s+(\d+)/);
                    if (limitMatch) {
                        const limitName = limitMatch[1].trim();
                        const used = parseInt(limitMatch[2]);
                        const total = parseInt(limitMatch[3]);
                        
                        limitMap.set(limitName, { used, total });
                        
                        analysis.governorLimits.push({
                            name: limitName,
                            usage: used,
                            total: total
                        });
                    }
                }
                else if (eventType.includes('METHOD_ENTRY') && parts[2] && parts[2].includes('Database.')) {
                    analysis.summary.numDatabaseCalls++;
                }
                else if (eventType.includes('CODE_COVERAGE')) {
                    const coverageInfo = parts.slice(2).join('|').trim();
                    analysis.hasCoverageInfo = true;
                    
                    // Try to extract coverage percentage
                    const percentMatch = coverageInfo.match(/(\d+)%/);
                    if (percentMatch) {
                        if (!analysis.codeCoverage) {
                            analysis.codeCoverage = {
                                coveragePercentage: parseInt(percentMatch[1]),
                                linesCovered: 0,
                                linesTotal: 0,
                                uncoveredLines: []
                            };
                        }
                    }
                    
                    analysis.timeline.push({
                        event: 'Code Coverage',
                        timeMs: relativeTimeMs,
                        details: coverageInfo
                    });
                }
            } catch (error) {
                // Skip lines that can't be processed
                continue;
            }
        }
        
        // Process the limits and convert to array
        for (const [name, { used, total }] of limitMap.entries()) {
            analysis.limits.push({
                name,
                used,
                total,
                percentage: Math.round((used / total) * 100)
            });
        }
        
        // Sort limits by percentage (highest first)
        analysis.limits.sort((a, b) => b.percentage - a.percentage);
        
        return analysis;
    }
    
    /**
     * Helper function to escape HTML to prevent XSS
     */
    private static escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    
    /**
     * Renders the log analysis as HTML
     */
    public static renderLogAnalysisAsHtml(analysis: LogAnalysis, rawLogText: string, codeText?: string): string {
        // Function to format numbers with commas
        const formatNumber = (num: number) => num.toLocaleString();
        
        // Generate a unique ID for this log block to avoid conflicts with multiple blocks
        const uniqueId = `log_${Math.random().toString(36).substr(2, 9)}`;
        
        // Get the execution datetime from the log
        const executionDatetime = this.extractExecutionDatetime(rawLogText);
        const formattedDatetime = executionDatetime.toLocaleString();
        
        // Prepare log text for storage in data attribute
        const encodedLogText = JSON.stringify(rawLogText);
        
        // Start building the HTML with styles
        let html = this.generateStyles();
        
        // Main container with collapsible header
        html += `
        <div class="log-analyzer" id="log_container_${uniqueId}" style="padding: 10px; border-radius: 6px; margin-bottom: 10px;">
            ${this.generateCollapsibleHeader(analysis, formattedDatetime, uniqueId)}
            <div class="collapsible-content" id="collapsible-content-${uniqueId}">
                ${this.generateViewToggleButton(uniqueId)}
                
                <div id="analyzedLogView_${uniqueId}">
                    ${this.generateSummaryPanels(analysis, formatNumber)}
                    ${this.generateLogDataScript(encodedLogText, uniqueId)}
                    ${this.generateInfoMessage()}
                    ${this.generateGovernorLimitsSection(analysis)}
                    ${this.generateDebugStatementsSection(analysis)}
                    ${this.generateErrorsSection(analysis)}
                    ${this.generateTimelineSection(analysis)}
                </div>
                
                ${this.generateRawLogView(rawLogText, uniqueId)}
            </div>
        </div>`;
        
        // Add JavaScript for interactive elements
        html += this.generateJavaScript(uniqueId);
        
        return html;
    }
    
    /**
     * Extract the execution datetime from the log
     */
    private static extractExecutionDatetime(rawLogText: string): Date {
        const executionDatetime = new Date();
        const lines = rawLogText.split('\n');
        
        if (lines.length > 0) {
            // Try to extract the timestamp from the first log line
            const firstLineWithContent = lines.find(line => line.trim().length > 0);
            if (firstLineWithContent) {
                const timestampPart = firstLineWithContent.split('|')[0];
                if (timestampPart && !isNaN(Number(timestampPart))) {
                    // Convert Unix timestamp to date if it looks like a valid number
                    const timestamp = parseFloat(timestampPart);
                    return new Date(timestamp * 1000); // Convert seconds to milliseconds
                }
            }
        }
        
        return executionDatetime;
    }
    
    /**
     * Generate CSS styles for the log analyzer
     */
    private static generateStyles(): string {
        return `
        <style>
            .log-analyzer {
                font-family: var(--vscode-font-family, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border, #ddd);
                font-size: 13px;
            }
            
            /* Button styles */
            .log-analyzer button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 4px;
                margin-left: 8px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 12px;
            }
            .log-analyzer button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            
            /* Panel and container styles */
            .log-analyzer .panel {
                background-color: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.1));
                border-radius: 4px;
                padding: 8px;
            }
            .log-analyzer .error-panel {
                background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
                border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.3));
            }
            .log-analyzer summary {
                color: var(--vscode-foreground);
                font-weight: bold;
                font-size: 13px;
                margin-bottom: 5px;
                cursor: pointer;
            }
            .log-analyzer .dim-text {
                color: var(--vscode-descriptionForeground);
            }
            .log-analyzer .button-container {
                display: flex;
                justify-content: flex-end;
                align-items: center;
                margin-bottom: 10px;
            }
            
            /* Progress bar styles */
            .log-analyzer .progress-bar {
                background-color: var(--vscode-progressBar-background);
                height: 8px;
                width: 100%;
                border-radius: 4px;
                overflow: hidden;
            }
            .log-analyzer .progress-green {
                background-color: var(--vscode-debugIcon-startForeground, #198754);
                height: 100%;
            }
            .log-analyzer .progress-warning {
                background-color: var(--vscode-editorWarning-foreground, #fd7e14);
                height: 100%;
            }
            .log-analyzer .progress-error {
                background-color: var(--vscode-errorForeground, #dc3545);
                height: 100%;
            }
            
            /* Typography styles */
            .log-analyzer .monospace {
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: 12px;
            }
            .log-analyzer .debug-line-number {
                color: var(--vscode-debugTokenExpression-name, #0d6efd);
                font-weight: bold;
            }
            .log-analyzer .error-text {
                color: var(--vscode-errorForeground, #842029);
            }
            
            /* Event color coding */
            .log-analyzer .event-soql {
                color: var(--vscode-symbolIcon-variableForeground, #0d6efd);
            }
            .log-analyzer .event-dml {
                color: var(--vscode-symbolIcon-classForeground, #6f42c1);
            }
            .log-analyzer .event-debug {
                color: var(--vscode-debugTokenExpression-string, #198754);
            }
            .log-analyzer .event-error {
                color: var(--vscode-errorForeground, #dc3545);
            }
            
            /* Collapsible component styles */
            .log-analyzer .collapsible-header {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                background-color: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.1));
                border-radius: 4px;
                margin-bottom: 10px;
                cursor: pointer;
                user-select: none;
                border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            }
            .log-analyzer .collapsible-header:hover {
                background-color: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.2));
            }
            .log-analyzer .collapsible-content {
                transition: max-height 0.3s ease-out;
                overflow: hidden;
            }
            .log-analyzer .collapsible-content.collapsed {
                max-height: 0px !important;
                overflow: hidden;
            }
            .log-analyzer .collapsible-icon {
                display: inline-block;
                margin-right: 8px;
                transition: transform 0.3s ease;
            }
            .log-analyzer .collapsible-icon.collapsed {
                transform: rotate(-90deg);
            }
            
            /* Metric display styles */
            .log-analyzer .metric {
                margin-right: 15px;
                display: inline-flex;
                align-items: center;
            }
            .log-analyzer .metric-label {
                font-size: 12px;
                margin-right: 4px;
                opacity: 0.7;
            }
            .log-analyzer .metric-value {
                font-weight: bold;
            }
            .log-analyzer .has-error {
                color: var(--vscode-errorForeground, #dc3545);
            }
        </style>`;
    }
    
    /**
     * Generate the collapsible header with key metrics
     */
    private static generateCollapsibleHeader(analysis: LogAnalysis, formattedDatetime: string, uniqueId: string): string {
        return `
        <div class="collapsible-header" onclick="toggleCollapse_${uniqueId}()">
            <span class="collapsible-icon" id="collapse-icon-${uniqueId}">▼</span>
            <div style="flex-grow: 1; display: flex; align-items: center; flex-wrap: wrap;">
                <div style="font-weight: bold; font-size: 14px; margin-right: 15px;">
                    🔍 Apex Log Analysis
                </div>
                <div class="metric">
                    <span class="metric-label">Time:</span>
                    <span class="metric-value">${analysis.totalExecutionTimeMs.toLocaleString()} ms</span>
                </div>
                <div class="metric">
                    <span class="metric-label">SOQL:</span>
                    <span class="metric-value">${analysis.summary.numSoqlQueries.toLocaleString()}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">DML:</span>
                    <span class="metric-value">${analysis.summary.numDmlStatements.toLocaleString()}</span>
                </div>
                ${analysis.errors.length > 0 ? `
                <div class="metric has-error">
                    <span class="metric-label">Errors:</span>
                    <span class="metric-value">${analysis.errors.length}</span>
                </div>
                ` : ''}
                <span class="dim-text" style="font-size: 12px; margin-left: auto; font-weight: normal;">
                    ${formattedDatetime}
                </span>
            </div>
        </div>`;
    }
    
    /**
     * Generate the view toggle button
     */
    private static generateViewToggleButton(uniqueId: string): string {
        return `
        <div class="button-container">
            <button id="viewToggleBtn_${uniqueId}" onclick="toggleLogView_${uniqueId}(event)">
                View Raw Log
            </button>
        </div>`;
    }
    
    /**
     * Generate the summary panels (cards) with key metrics
     */
    private static generateSummaryPanels(analysis: LogAnalysis, formatNumber: (num: number) => string): string {
        return `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 15px;">
            <div class="panel">
                <div class="dim-text" style="font-size: 12px;">Total Time</div>
                <div style="font-weight: bold; font-size: 14px;">${formatNumber(analysis.totalExecutionTimeMs)} ms</div>
            </div>
            <div class="panel">
                <div class="dim-text" style="font-size: 12px;">SOQL Queries</div>
                <div style="font-weight: bold; font-size: 14px;">${formatNumber(analysis.summary.numSoqlQueries)}</div>
            </div>
            <div class="panel">
                <div class="dim-text" style="font-size: 12px;">DML Statements</div>
                <div style="font-weight: bold; font-size: 14px;">${formatNumber(analysis.summary.numDmlStatements)}</div>
            </div>
            <div class="panel">
                <div class="dim-text" style="font-size: 12px;">Peak Heap Size</div>
                <div style="font-weight: bold; font-size: 14px;">${formatNumber(analysis.summary.heapSize)} bytes</div>
            </div>
            ${analysis.hasCoverageInfo && analysis.codeCoverage ? `
            <div class="panel">
                <div class="dim-text" style="font-size: 12px;">Code Coverage</div>
                <div style="font-weight: bold; font-size: 14px;">${analysis.codeCoverage.coveragePercentage}%</div>
            </div>
            ` : ''}
        </div>`;
    }
    
    /**
     * Generate the script tag that stores the log data
     */
    private static generateLogDataScript(encodedLogText: string, uniqueId: string): string {
        return `
        <script id="logDataScript_${uniqueId}" type="text/plain" data-log-content="${this.escapeHtml(encodedLogText)}">
        // This script tag contains the raw log data in the data-log-content attribute
        // It's used by the extension to extract the log text when needed
        </script>`;
    }
    
    /**
     * Generate the info message about the status bar button
     */
    private static generateInfoMessage(): string {
        return `
        <div style="margin-bottom: 15px; padding: 8px 12px; border-radius: 4px; font-size: 12px; background-color: var(--vscode-editorInfo-background, rgba(0, 120, 212, 0.1)); color: var(--vscode-editorInfo-foreground, #0078D4)); border: 1px solid var(--vscode-editorInfo-border, rgba(0, 120, 212, 0.3));">
            <span style="font-weight: bold;">💡 Tip:</span> Use the <span style="font-weight: bold;">Open Log in Analyzer</span> button in the status bar (look for 🔍 icon) to open this log in the full Apex Log Analyzer extension.
        </div>`;
    }
    
    /**
     * Generate the governor limits section
     */
    private static generateGovernorLimitsSection(analysis: LogAnalysis): string {
        if (analysis.governorLimits.length === 0) {
            return '';
        }
        
        // Sort limits for better display (most utilized first)
        const sortedLimits = [...analysis.governorLimits].sort((a, b) => 
            (b.usage / b.total) - (a.usage / a.total)
        );
        
        let limitItems = '';
        for (const limit of sortedLimits) {
            const percentage = Math.round((limit.usage / limit.total) * 100);
            
            // Determine color based on usage percentage
            let progressClass = 'progress-green';
            if (percentage > 75) {
                progressClass = 'progress-error';
            } else if (percentage > 50) {
                progressClass = 'progress-warning';
            }
            
            limitItems += `
            <div style="margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                    <span>${this.escapeHtml(limit.name)}</span>
                    <span>${limit.usage} / ${limit.total} (${percentage}%)</span>
                </div>
                <div class="progress-bar">
                    <div class="${progressClass}" style="width: ${percentage}%;"></div>
                </div>
            </div>`;
        }
        
        return `
        <details>
            <summary>📊 Governor Limits</summary>
            <div class="panel monospace" style="margin-bottom: 15px;">
                ${limitItems}
            </div>
        </details>`;
    }
    
    /**
     * Generate the debug statements section
     */
    private static generateDebugStatementsSection(analysis: LogAnalysis): string {
        if (analysis.debugLines.length === 0) {
            return '';
        }
        
        let debugItems = '';
        for (const debug of analysis.debugLines) {
            debugItems += `
            <div style="margin-bottom: 4px;">
                <span class="debug-line-number">Line ${debug.lineNumber}:</span> ${this.escapeHtml(debug.message)}
            </div>`;
        }
        
        return `
        <details open>
            <summary>🐞 Debug Statements</summary>
            <div class="panel monospace" style="margin-bottom: 15px;">
                ${debugItems}
            </div>
        </details>`;
    }
    
    /**
     * Generate the errors section
     */
    private static generateErrorsSection(analysis: LogAnalysis): string {
        if (analysis.errors.length === 0) {
            return '';
        }
        
        let errorItems = '';
        for (const error of analysis.errors) {
            errorItems += `
            <div style="margin-bottom: 4px;" class="error-text">
                ${this.escapeHtml(error.message)}
                ${error.lineNumber ? `(Line ${error.lineNumber})` : ''}
                ${error.stackTrace ? `<pre style="margin-top: 4px; white-space: pre-wrap;">${this.escapeHtml(error.stackTrace)}</pre>` : ''}
            </div>`;
        }
        
        return `
        <details open>
            <summary>❌ Errors</summary>
            <div class="error-panel monospace" style="margin-bottom: 15px;">
                ${errorItems}
            </div>
        </details>`;
    }
    
    /**
     * Generate the timeline section
     */
    private static generateTimelineSection(analysis: LogAnalysis): string {
        if (analysis.timeline.length === 0) {
            return '';
        }
        
        let timelineItems = '';
        for (const event of analysis.timeline) {
            // Color code different events
            let eventClass = '';
            if (event.event.includes('SOQL')) eventClass = 'event-soql';
            if (event.event.includes('DML')) eventClass = 'event-dml';
            if (event.event.includes('Debug')) eventClass = 'event-debug';
            if (event.event.includes('Error')) eventClass = 'event-error';
            
            timelineItems += `
            <div style="margin-bottom: 4px; display: flex;">
                <span class="dim-text" style="min-width: 60px;">${event.timeMs}ms</span>
                <span class="${eventClass}">${event.event}</span>
                ${event.details ? `: <span style="margin-left: 4px;">${this.escapeHtml(event.details)}</span>` : ''}
            </div>`;
        }
        
        return `
        <details>
            <summary>⏰ Execution Timeline</summary>
            <div class="panel monospace" style="max-height: 200px; overflow-y: auto;">
                ${timelineItems}
            </div>
        </details>`;
    }
    
    /**
     * Generate the raw log view section
     */
    private static generateRawLogView(rawLogText: string, uniqueId: string): string {
        return `
        <div id="rawLogView_${uniqueId}" style="display: none;">
            <details open>
                <summary>📄 Full Log</summary>
                <div class="panel monospace" style="margin-bottom: 15px; white-space: pre-wrap; overflow-x: auto; max-height: 500px; overflow-y: auto;">
                    ${this.escapeHtml(rawLogText)}
                </div>
            </details>
        </div>`;
    }
    
    /**
     * Generate the JavaScript for interactive elements
     */
    private static generateJavaScript(uniqueId: string): string {
        return `
        <script>
            // Calculate content height once loaded
            document.addEventListener('DOMContentLoaded', function() {
                const content = document.getElementById('collapsible-content-${uniqueId}');
                if (content) {
                    content.style.maxHeight = content.scrollHeight + 'px';
                }
            });
            
            // Collapse/expand functionality
            function toggleCollapse_${uniqueId}() {
                const content = document.getElementById('collapsible-content-${uniqueId}');
                const icon = document.getElementById('collapse-icon-${uniqueId}');
                
                if (content.classList.contains('collapsed')) {
                    // Expand
                    content.classList.remove('collapsed');
                    content.style.maxHeight = content.scrollHeight + 'px';
                    icon.classList.remove('collapsed');
                } else {
                    // Collapse
                    content.classList.add('collapsed');
                    content.style.maxHeight = '0px';
                    icon.classList.add('collapsed');
                }
            }
            
            // View toggle functionality - note the event parameter to stop propagation
            function toggleLogView_${uniqueId}(event) {
                // Prevent the click from triggering the parent collapse function
                event.stopPropagation();
                
                const analyzedView = document.getElementById('analyzedLogView_${uniqueId}');
                const rawView = document.getElementById('rawLogView_${uniqueId}');
                const toggleBtn = document.getElementById('viewToggleBtn_${uniqueId}');
                
                if (analyzedView.style.display === 'none') {
                    analyzedView.style.display = 'block';
                    rawView.style.display = 'none';
                    toggleBtn.innerText = 'View Raw Log';
                } else {
                    analyzedView.style.display = 'none';
                    rawView.style.display = 'block';
                    toggleBtn.innerText = 'View Analysis';
                }
                
                // Update content height after changing view
                const content = document.getElementById('collapsible-content-${uniqueId}');
                setTimeout(() => {
                    content.style.maxHeight = content.scrollHeight + 'px';
                }, 10);
            }
        </script>`;
    }
} 
