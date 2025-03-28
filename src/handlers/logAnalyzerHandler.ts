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

/**
 * Handler for analyzing Apex execution logs
 */
export class LogAnalyzerHandler {
    /**
     * Analyzes an Apex execution log and extracts useful information
     */
    public static analyzeApexLog(log: string): LogAnalysis {
        // Clean the log by removing executed anonymous code sections
        log = this.removeExecutedAnonymousCode(log);
        
        const analysis = this.initializeAnalysis();
        const lines = log.split('\n');
        let startTime = 0;
        let endTime = 0;
        
        // Track limits
        const limitMap = new Map<string, { used: number; total: number }>();
        
        // Track the last USER_DEBUG line for collecting continued content
        let lastDebugLineIndex: number = -1;
        
        // Process each line of the log
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            
            try {
                // Handle multi-line debug statements
                if (this.isPartOfPreviousDebugLine(lastDebugLineIndex, line)) {
                    this.processContinuedDebugLine(analysis, line);
                    continue;
                }
                
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
                    this.processExecutionStarted(analysis);
                    lastDebugLineIndex = -1;
                } 
                else if (eventType.includes('EXECUTION_FINISHED')) {
                    endTime = currentTime;
                    this.processExecutionFinished(analysis, startTime, endTime);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('SOQL_EXECUTE_BEGIN')) {
                    this.processSoqlQuery(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('DML_BEGIN')) {
                    this.processDmlOperation(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('USER_DEBUG')) {
                    lastDebugLineIndex = i;
                    i = this.processUserDebug(analysis, lines, i, parts, relativeTimeMs, timestamp);
                }
                else if (eventType.includes('HEAP_ALLOCATE')) {
                    this.processHeapAllocation(analysis, line);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('EXCEPTION_THROWN') || eventType.includes('FATAL_ERROR')) {
                    this.processException(analysis, parts, relativeTimeMs, lines, i);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('SYSTEM_METHOD_ENTRY')) {
                    this.processMethodEntry(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('SYSTEM_METHOD_EXIT')) {
                    this.processMethodExit(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('LIMIT_USAGE_FOR_NS')) {
                    this.processLimitUsage(analysis, limitMap, parts);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('CUMULATIVE_LIMIT_USAGE')) {
                    this.processCumulativeLimits(analysis, limitMap, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('CUMULATIVE_PROFILING')) {
                    this.processProfilingData(analysis, parts);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('CODE_COVERAGE')) {
                    this.processCodeCoverage(analysis, parts);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('SYSTEM_MODE_ENTER') || eventType.includes('SYSTEM_MODE_EXIT')) {
                    this.processSystemMode(analysis, eventType, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('CONSTRUCTOR_ENTRY') || eventType.includes('CONSTRUCTOR_EXIT')) {
                    this.processConstructor(analysis, eventType, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('METHOD_ENTRY') || eventType.includes('METHOD_EXIT')) {
                    this.processCustomMethod(analysis, eventType, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('SOQL_EXECUTE_END')) {
                    this.processSoqlEnd(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                else if (eventType.includes('DML_END')) {
                    this.processDmlEnd(analysis, parts, relativeTimeMs);
                    lastDebugLineIndex = -1;
                }
                
            } catch (error) {
                console.error(`Error processing log line ${i}: ${error}`);
                // Continue to next line even if there was an error
            }
        }
        
        // Finalize analysis and return results
        return this.finalizeAnalysis(analysis, limitMap);
    }

    /**
     * Initialize a new log analysis object
     */
    private static initializeAnalysis(): LogAnalysis {
        return {
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
    }

    /**
     * Check if a line is part of a previous debug line
     */
    private static isPartOfPreviousDebugLine(lastDebugLineIndex: number, line: string): boolean {
        return lastDebugLineIndex >= 0 && !line.match(/^\d+:\d+:\d+/);
    }

    /**
     * Process a continued debug line
     */
    private static processContinuedDebugLine(analysis: LogAnalysis, line: string): void {
        if (analysis.debugLines.length > 0) {
            // Append to the last debug message, preserving the line as-is (even if empty)
            const lastDebug = analysis.debugLines[analysis.debugLines.length - 1];
            
            // Remove "DEBUG|" prefix if present before adding to the debug message
            const cleanedLine = line.replace(/^DEBUG\|/, '');
            lastDebug.message += '\n' + cleanedLine;
            
            // Also update the timeline
            for (let j = analysis.timeline.length - 1; j >= 0; j--) {
                const event = analysis.timeline[j];
                if (event.event === 'Debug Log') {
                    // Update the details in timeline
                    const lineNumber = lastDebug.lineNumber;
                    event.details = `Line ${lineNumber}: ${lastDebug.message.split('\n')[0]}...`;
                    break;
                }
            }
        }
    }

    /**
     * Process execution started event
     */
    private static processExecutionStarted(analysis: LogAnalysis): void {
        analysis.timeline.push({ event: 'Execution Started', timeMs: 0 });
    }

    /**
     * Process execution finished event
     */
    private static processExecutionFinished(analysis: LogAnalysis, startTime: number, endTime: number): void {
        analysis.totalExecutionTimeMs = Math.round((endTime - startTime) * 1000);
        analysis.summary.totalTimeMs = analysis.totalExecutionTimeMs;
        analysis.timeline.push({ event: 'Execution Finished', timeMs: analysis.totalExecutionTimeMs });
    }

    /**
     * Process SOQL query event
     */
    private static processSoqlQuery(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        analysis.summary.numSoqlQueries++;
        const queryDetails = parts.slice(2).join('|').trim();
        analysis.timeline.push({ 
            event: 'SOQL Query', 
            timeMs: relativeTimeMs,
            details: queryDetails
        });
    }

    /**
     * Process DML operation event
     */
    private static processDmlOperation(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        analysis.summary.numDmlStatements++;
        analysis.timeline.push({ 
            event: 'DML Operation', 
            timeMs: relativeTimeMs,
            details: parts.slice(2).join('|').trim()
        });
    }

    /**
     * Helper method to extract content until the next timestamp line
     * This is used by both debug and error processing to capture multi-line content
     */
    private static extractContentUntilNextTimestamp(lines: string[], startIndex: number): { content: string, newIndex: number } {
        const extractedLines = [];
        let currentIndex = startIndex + 1;
        
        while (currentIndex < lines.length) {
            const line = lines[currentIndex];
            
            // If the line starts with a timestamp pattern (like "12:02:53.23"), stop collecting
            if (line.match(/^\d+:\d+:\d+/)) {
                break;
            }

            extractedLines.push(line);
            currentIndex++;
        }
        
        // Return the collected content and the new index
        return {
            content: extractedLines.join('\n'),
            newIndex: currentIndex - 1 // -1 because the loop will increment once more
        };
    }

    /**
     * Process user debug event
     */
    private static processUserDebug(
        analysis: LogAnalysis, 
        lines: string[], 
        currentIndex: number, 
        parts: string[], 
        relativeTimeMs: number, 
        timestamp: string
    ): number {
        const lineMatch = parts[2].match(/\[(\d+)\]/);
        const lineNumber = lineMatch ? parseInt(lineMatch[1]) : 0;
        
        // Get the raw debug message by joining all remaining parts without trimming
        let message = parts.slice(3).join('|');
              
        // Remove "DEBUG|" prefix if present, but preserve other whitespace
        message = message.replace(/^DEBUG\|/, '');
        
        // Extract additional content until the next timestamp
        const { content, newIndex } = this.extractContentUntilNextTimestamp(lines, currentIndex);
        
        // Append any extracted content to the message

        // if (content) {
            message += '\n' + content;
        // }
              
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
        
        return newIndex;
    }

    /**
     * Process heap allocation event
     */
    private static processHeapAllocation(analysis: LogAnalysis, line: string): void {
        const heapMatch = line.match(/Bytes:(\d+)/);
        if (heapMatch) {
            const heapSize = parseInt(heapMatch[1]);
            if (heapSize > analysis.summary.heapSize) {
                analysis.summary.heapSize = heapSize;
            }
        }
    }

    /**
     * Process exception event
     */
    private static processException(
        analysis: LogAnalysis, 
        parts: string[], 
        relativeTimeMs: number, 
        lines: string[], 
        currentIndex: number
    ): void {
        const errorMessage = parts.slice(2).join('|').trim();
        
        // Extract line and column numbers if present in the error message
        let lineNumber: number | undefined;
        let columnNumber: number | undefined;
        
        // Look for line/column patterns like "line 15, column 32" or similar
        const lineColMatch = errorMessage.match(/line\s+(\d+)(?:,\s*column\s+(\d+))?/i);
        if (lineColMatch) {
            lineNumber = parseInt(lineColMatch[1]);
            if (lineColMatch[2]) {
                columnNumber = parseInt(lineColMatch[2]);
            }
        }
        
        // Extract stack trace content until the next timestamp
        const { content: stackTrace, newIndex } = this.extractContentUntilNextTimestamp(lines, currentIndex);
        
        // Create the error object
        const errorObj: {
            message: string;
            lineNumber?: number;
            columnNumber?: number;
            stackTrace?: string;
        } = { 
            message: errorMessage,
            lineNumber,
            columnNumber
        };
        
        if (stackTrace) {
            errorObj.stackTrace = stackTrace;
        }
        
        analysis.errors.push(errorObj);
        
        analysis.timeline.push({ 
            event: 'Error', 
            timeMs: relativeTimeMs,
            details: errorMessage
        });
    }

    /**
     * Process method entry event
     */
    private static processMethodEntry(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        const methodName = parts[2] || 'Unknown Method';
        analysis.timeline.push({ 
            event: 'Method Entry', 
            timeMs: relativeTimeMs,
            details: methodName
        });
    }

    /**
     * Process method exit event
     */
    private static processMethodExit(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        const methodName = parts[2] || 'Unknown Method';
        analysis.timeline.push({ 
            event: 'Method Exit', 
            timeMs: relativeTimeMs,
            details: methodName
        });
    }

    /**
     * Process limit usage event
     */
    private static processLimitUsage(
        analysis: LogAnalysis, 
        limitMap: Map<string, { used: number; total: number }>, 
        parts: string[]
    ): void {
        // Parse LIMIT_USAGE information
        for (let j = 2; j < parts.length; j++) {
            const limitPart = parts[j].trim();
            if (!limitPart) continue;
            
            const limitMatch = limitPart.match(/([^:]+):\s*(\d+)\s*of\s*(\d+)/);
            if (limitMatch) {
                const limitName = limitMatch[1].trim();
                const used = parseInt(limitMatch[2]);
                const total = parseInt(limitMatch[3]);
                
                // Store in map for later processing
                limitMap.set(limitName, { used, total });
            }
        }
    }

    /**
     * Process cumulative limits event
     */
    private static processCumulativeLimits(
        analysis: LogAnalysis, 
        limitMap: Map<string, { used: number; total: number }>, 
        parts: string[],
        relativeTimeMs: number
    ): void {
        // Process all limits at once
        for (let j = 3; j < parts.length; j++) {
            const limitPart = parts[j].trim();
            if (!limitPart) continue;
            
            const limitMatch = limitPart.match(/([^:]+):\s*(\d+)\s*of\s*(\d+)/);
            if (limitMatch) {
                const limitName = limitMatch[1].trim();
                const used = parseInt(limitMatch[2]);
                const total = parseInt(limitMatch[3]);
                
                // Store in map for later processing
                limitMap.set(limitName, { used, total });
                
                // Update governor limits data
                analysis.governorLimits.push({
                    name: limitName,
                    usage: used,
                    total: total
                });
                
                // Add to timeline for significant limit usage (>50%)
                if (used > 0 && (used / total) > 0.5) {
                    const percentage = Math.round((used / total) * 100);
                    analysis.timeline.push({
                        event: 'High Limit Usage',
                        timeMs: relativeTimeMs,
                        details: `${limitName}: ${used} of ${total} (${percentage}%)`
                    });
                }
            }
        }
    }

    /**
     * Process profiling data event
     */
    private static processProfilingData(analysis: LogAnalysis, parts: string[]): void {
        // Placeholder for profiling data processing
        // This would extract method execution times and call hierarchy
    }

    /**
     * Process code coverage event
     */
    private static processCodeCoverage(analysis: LogAnalysis, parts: string[]): void {
        analysis.hasCoverageInfo = true;
        
        // Simple coverage detection - could be expanded for more detailed coverage information
        const coverageText = parts.slice(2).join('|');
        
        // Extract coverage percentage if available
        const percentMatch = coverageText.match(/(\d+)%/);
        if (percentMatch) {
            const coveragePercentage = parseInt(percentMatch[1]);
            
            if (!analysis.codeCoverage) {
                analysis.codeCoverage = {
                    coveragePercentage: coveragePercentage,
                    linesCovered: 0,
                    linesTotal: 0,
                    uncoveredLines: []
                };
            } else {
                analysis.codeCoverage.coveragePercentage = coveragePercentage;
            }
        }
        
        // Extract covered/uncovered lines
        const linesMatch = coverageText.match(/(\d+)\/(\d+)/);
        if (linesMatch) {
            const linesCovered = parseInt(linesMatch[1]);
            const linesTotal = parseInt(linesMatch[2]);
            
            if (!analysis.codeCoverage) {
                analysis.codeCoverage = {
                    coveragePercentage: Math.round((linesCovered / linesTotal) * 100),
                    linesCovered: linesCovered,
                    linesTotal: linesTotal,
                    uncoveredLines: []
                };
            } else {
                analysis.codeCoverage.linesCovered = linesCovered;
                analysis.codeCoverage.linesTotal = linesTotal;
            }
        }
        
        // Extract uncovered lines
        const uncoveredLinesMatch = coverageText.match(/Lines not covered: ([^\|]+)/);
        if (uncoveredLinesMatch) {
            const uncoveredText = uncoveredLinesMatch[1];
            const uncoveredLines = uncoveredText.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
            
            if (!analysis.codeCoverage) {
                analysis.codeCoverage = {
                    coveragePercentage: 0,
                    linesCovered: 0,
                    linesTotal: 0,
                    uncoveredLines: uncoveredLines
                };
            } else {
                analysis.codeCoverage.uncoveredLines = uncoveredLines;
            }
        }
    }

    /**
     * Process system mode event
     */
    private static processSystemMode(analysis: LogAnalysis, eventType: string, relativeTimeMs: number): void {
        const isEnter = eventType.includes('SYSTEM_MODE_ENTER');
        analysis.timeline.push({
            event: isEnter ? 'System Mode Enter' : 'System Mode Exit',
            timeMs: relativeTimeMs
        });
    }

    /**
     * Process constructor event
     */
    private static processConstructor(analysis: LogAnalysis, eventType: string, parts: string[], relativeTimeMs: number): void {
        const isEntry = eventType.includes('CONSTRUCTOR_ENTRY');
        const className = parts[2] || 'Unknown Class';
        
        analysis.timeline.push({
            event: isEntry ? 'Constructor Entry' : 'Constructor Exit',
            timeMs: relativeTimeMs,
            details: className
        });
    }

    /**
     * Process custom method event
     */
    private static processCustomMethod(analysis: LogAnalysis, eventType: string, parts: string[], relativeTimeMs: number): void {
        const isEntry = eventType.includes('METHOD_ENTRY');
        const methodName = parts[2] || 'Unknown Method';
        
        analysis.timeline.push({
            event: isEntry ? 'Method Entry' : 'Method Exit',
            timeMs: relativeTimeMs,
            details: methodName
        });
    }

    /**
     * Process SOQL end event
     */
    private static processSoqlEnd(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        // Extract execution time if available
        const durationMatch = parts.slice(2).join('|').match(/Duration=(\d+)/);
        if (durationMatch) {
            const durationMs = parseInt(durationMatch[1]);
            analysis.summary.dbTimeMs += durationMs;
            
            analysis.timeline.push({
                event: 'SOQL Query Completed',
                timeMs: relativeTimeMs,
                details: `Duration: ${durationMs}ms`
            });
        }
    }

    /**
     * Process DML end event
     */
    private static processDmlEnd(analysis: LogAnalysis, parts: string[], relativeTimeMs: number): void {
        // Extract execution time if available
        const durationMatch = parts.slice(2).join('|').match(/Duration=(\d+)/);
        if (durationMatch) {
            const durationMs = parseInt(durationMatch[1]);
            analysis.summary.dbTimeMs += durationMs;
            
            analysis.timeline.push({
                event: 'DML Operation Completed',
                timeMs: relativeTimeMs,
                details: `Duration: ${durationMs}ms`
            });
        }
    }

    /**
     * Finalize the analysis by computing derived metrics
     */
    private static finalizeAnalysis(
        analysis: LogAnalysis, 
        limitMap: Map<string, { used: number; total: number }>
    ): LogAnalysis {
        // Process limits data into a format for display
        limitMap.forEach((value, key) => {
            const percentage = value.total > 0 ? Math.round((value.used / value.total) * 100) : 0;
            
            analysis.limits.push({
                name: key,
                used: value.used,
                total: value.total,
                percentage
            });
        });
        
        // Sort limits by percentage usage (descending)
        analysis.limits.sort((a, b) => b.percentage - a.percentage);
        
        // Compute database calls total
        analysis.summary.numDatabaseCalls = analysis.summary.numSoqlQueries + analysis.summary.numDmlStatements;
        
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
        const formattedDatetime = executionDatetime ? executionDatetime.toLocaleString() : 'Unknown time';
        
        // Clean the raw log text to remove Execute Anonymous sections
        const cleanedRawLogText = this.removeExecutedAnonymousCode(rawLogText);
        
        // Base 64 encode for data storage (not used directly, but useful to have)
        const encodedLogText = Buffer.from(rawLogText).toString('base64');
        
        // Start building the HTML
        let html = `
        <div class="log-analyzer">
            ${this.generateCssStyles()}
            
            ${this.generateCollapsibleHeader(analysis, formattedDatetime, uniqueId)}
            
            <div id="collapsible-content-${uniqueId}" class="collapsible-content">
                <div id="analyzedLogView_${uniqueId}">
                    ${this.generateSummaryPanels(analysis, formatNumber)}
                    
                    ${this.generateGovernorLimitsSection(analysis)}
                    
                    ${analysis.errors.length > 0 ? this.generateErrorsSection(analysis) : ''}
                    
                    ${analysis.debugLines.length > 0 ? this.generateDebugStatementsSection(analysis) : ''}
                    
                    ${this.generateTimelineSection(analysis)}
                </div>
                
                ${this.generateRawLogView(cleanedRawLogText, uniqueId)}
                
                ${this.generateLogDataScript(encodedLogText, uniqueId)}
            </div>
            
            ${this.generateJavaScript(uniqueId)}
        </div>`;
        
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
    private static generateCssStyles(): string {
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
                border-radius: 4px;
                padding: 12px;
            }
            
            /* Timeline styles */
            .log-analyzer .timeline-container {
                padding: 10px;
            }
            .log-analyzer .timeline-item {
                padding: 2px 0;
            }
            .log-analyzer .timeline-error-item {
                padding: 4px 6px;
                border-radius: 3px;
                background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.05));
                margin-left: -6px;
                margin-right: -6px;
            }
            .log-analyzer .timeline-error-container {
                width: 100%;
            }
            .log-analyzer .timeline-error-message {
                display: flex;
                align-items: center;
                justify-content: space-between;
                color: var(--vscode-errorForeground, #ff0000);
                max-width: 100%;
            }
            .log-analyzer .timeline-toggle-btn {
                background: none;
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                padding: 1px 4px;
                font-size: 10px;
                cursor: pointer;
                background-color: var(--vscode-button-background);
                margin-left: 8px;
                height: 18px;
                min-width: 18px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .log-analyzer .timeline-toggle-btn:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .log-analyzer .timeline-error-details {
                margin-top: 4px;
                padding-top: 4px;
            }
            
            /* New error section styling */
            .log-analyzer .error-container {
                margin-bottom: 16px;
                padding-bottom: 8px;
            }
            .log-analyzer .error-container:not(:last-child) {
                border-bottom: 1px dashed var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.3));
            }
            .log-analyzer .error-message {
                color: var(--vscode-errorForeground, #ff0000);
                font-weight: bold;
                margin-bottom: 4px;
            }
            .log-analyzer .error-location {
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
                margin-bottom: 8px;
            }
            .log-analyzer .stack-trace {
                font-family: monospace;
                font-size: 12px;
                margin-top: 6px;
                padding: 8px;
                background-color: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.05));
                border-radius: 3px;
            }
            .log-analyzer .stack-trace ul li {
                padding: 3px 0;
                white-space: pre-wrap;
                word-break: break-all;
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
        // Removed the toggle button as requested
        return ``;
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
            // Handle the special case of multi-line debug messages with empty lines
            // Pre-wrap the content with <pre> tag to preserve formatting exactly
            debugItems += `
            <div style="margin-bottom: 10px;">
                <span class="debug-line-number">Line ${debug.lineNumber}:</span>
                <pre class="debug-message" style="margin: 0; font-family: var(--vscode-editor-font-family, monospace); white-space: pre; overflow-x: auto;">${this.escapeHtml(debug.message)}</pre>
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
            // Format stack trace lines with line breaks
            let formattedStackTrace = '';
            if (error.stackTrace) {
                const stackLines = error.stackTrace.split('\n');
                formattedStackTrace = `
                <div class="stack-trace">
                    <hr style="border-color: var(--vscode-input-placeholderForeground, #888); margin: 8px 0;">
                    <div style="font-weight: bold; margin-bottom: 4px;">Stack Trace:</div>
                    <ul style="list-style-type: none; padding-left: 0; margin-top: 4px;">
                        ${stackLines.map(line => `<li>${this.escapeHtml(line.trim())}</li>`).join('')}
                    </ul>
                </div>`;
            }
            
            errorItems += `
            <div class="error-container">
                <div class="error-message">${this.escapeHtml(error.message)}</div>
                ${error.lineNumber ? `<div class="error-location">Line: ${error.lineNumber}${error.columnNumber ? `, Column: ${error.columnNumber}` : ''}</div>` : ''}
                ${formattedStackTrace}
            </div>`;
        }
        
        return `
        <details open>
            <summary>❌ Errors</summary>
            <div class="error-panel" style="margin-bottom: 15px;">
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
            
            // For regular events
            if (event.event !== 'Error') {
                timelineItems += `
                <div class="timeline-item" style="margin-bottom: 4px; display: flex;">
                    <span class="dim-text" style="min-width: 60px;">${event.timeMs}ms</span>
                    <span class="${eventClass}">${event.event}</span>
                    ${event.details ? `: <span style="margin-left: 4px;">${this.escapeHtml(event.details)}</span>` : ''}
                </div>`;
            } 
            // Special handling for errors (matching the errors section UI)
            else if (event.details) {
                // Find the matching error in the errors array to get stack trace and other details
                const matchingError = analysis.errors.find(err => err.message === event.details);
                
                // Format stack trace lines with line breaks (same as in errors section)
                let formattedStackTrace = '';
                if (matchingError && matchingError.stackTrace) {
                    const stackLines = matchingError.stackTrace.split('\n');
                    formattedStackTrace = `
                    <div class="stack-trace">
                        <hr style="border-color: var(--vscode-input-placeholderForeground, #888); margin: 8px 0;">
                        <div style="font-weight: bold; margin-bottom: 4px;">Stack Trace:</div>
                        <ul style="list-style-type: none; padding-left: 0; margin-top: 4px;">
                            ${stackLines.map(line => `<li>${this.escapeHtml(line.trim())}</li>`).join('')}
                        </ul>
                    </div>`;
                }
                
                // Start with timestamp then add error with exact same format as error section
                timelineItems += `
                <div style="margin-bottom: 10px;">
                    <div style="display: flex; align-items: flex-start;">
                        <span class="dim-text" style="min-width: 60px;">${event.timeMs}ms</span>
                        <div class="error-container" style="margin: 0; flex: 1;">
                            <div class="error-message">${this.escapeHtml(event.details)}</div>
                            ${matchingError && matchingError.lineNumber ? 
                                `<div class="error-location">Line: ${matchingError.lineNumber}${matchingError.columnNumber ? `, Column: ${matchingError.columnNumber}` : ''}</div>` : ''}
                            ${formattedStackTrace}
                        </div>
                    </div>
                </div>`;
            }
        }
        
        return `
        <details>
            <summary>⏰ Execution Timeline</summary>
            <div class="panel monospace" style="max-height: 300px; overflow-y: auto;">
                ${timelineItems}
            </div>
        </details>`;
    }
    
    /**
     * Generate the raw log view section
     */
    private static generateRawLogView(rawLogText: string, uniqueId: string): string {
        return `
        <div id="rawLogView_${uniqueId}">
            <details>
                <summary>📄 Full Log</summary>
                <div class="search-container" style="margin-bottom: 10px; display: flex; align-items: center;">
                    <input 
                        type="text" 
                        id="searchInput_${uniqueId}" 
                        placeholder="Search in log..." 
                        style="flex: 1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background-color: var(--vscode-input-background); color: var(--vscode-input-foreground);"
                        onkeydown="if(event.key === 'Enter') { event.preventDefault(); document.getElementById('searchNext_${uniqueId}').click(); }"
                    />
                    <button 
                        id="searchPrev_${uniqueId}" 
                        title="Previous match"
                        style="margin-left: 4px; padding: 4px 8px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer;"
                        onclick="searchPrev_${uniqueId}()"
                    >◀</button>
                    <button 
                        id="searchNext_${uniqueId}" 
                        title="Next match"
                        style="margin-left: 4px; padding: 4px 8px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer;"
                        onclick="searchNext_${uniqueId}()"
                    >▶</button>
                    <span id="searchInfo_${uniqueId}" style="margin-left: 8px; font-size: 12px; color: var(--vscode-descriptionForeground);"></span>
                </div>
                <div id="logContent_${uniqueId}" class="panel monospace" style="margin-bottom: 15px; white-space: pre-wrap; overflow-x: auto; max-height: 500px; overflow-y: auto;">
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
            // Variables for search functionality
            let currentMatchIndex_${uniqueId} = -1;
            let matches_${uniqueId} = [];
            
            // Calculate content height once loaded
            document.addEventListener('DOMContentLoaded', function() {
                const content = document.getElementById('collapsible-content-${uniqueId}');
                if (content) {
                    content.style.maxHeight = content.scrollHeight + 'px';
                }
                
                // Initialize search functionality
                initSearch_${uniqueId}();
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
            
            // Function to escape regex special characters
            function escapeRegExp_${uniqueId}(string) {
                return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            }
            
            // Initialize search functionality
            function initSearch_${uniqueId}() {
                const searchInput = document.getElementById('searchInput_${uniqueId}');
                if (!searchInput) return;
                
                // Add input event listener
                searchInput.addEventListener('input', function() {
                    performSearch_${uniqueId}(this.value);
                });
            }
            
            // Perform search in log content
            function performSearch_${uniqueId}(searchText) {
                const logContent = document.getElementById('logContent_${uniqueId}');
                const searchInfo = document.getElementById('searchInfo_${uniqueId}');
                if (!logContent || !searchInfo) return;
                
                // Store the search text for comparison in next/prev functions
                window['logContent_${uniqueId}_lastSearchText'] = searchText.trim();
                
                // Reset content and variables
                logContent.innerHTML = logContent.textContent.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                currentMatchIndex_${uniqueId} = -1;
                matches_${uniqueId} = [];
                searchInfo.textContent = '';
                
                if (!searchText || searchText.trim() === '') return;
                
                try {
                    // Create regex pattern with escaped special characters
                    const pattern = escapeRegExp_${uniqueId}(searchText);
                    const regex = new RegExp(pattern, 'gi');
                    const content = logContent.textContent;
                    
                    // Find all matches
                    let match;
                    while ((match = regex.exec(content)) !== null) {
                        // Prevent infinite loops with zero-length matches
                        if (match.index === regex.lastIndex) {
                            regex.lastIndex++;
                        }
                        matches_${uniqueId}.push(match.index);
                    }
                    
                    // Display match count
                    if (matches_${uniqueId}.length > 0) {
                        currentMatchIndex_${uniqueId} = 0;
                        searchInfo.textContent = 'Match 1 of ' + matches_${uniqueId}.length;
                        
                        // Highlight all matches and scroll to first match
                        highlightMatches_${uniqueId}(searchText);
                    } else {
                        searchInfo.textContent = 'No matches found';
                    }
                } catch (e) {
                    console.error('Search error:', e);
                    searchInfo.textContent = 'Search error';
                }
            }
            
            // Highlight all search matches in the content
            function highlightMatches_${uniqueId}(searchText) {
                const logContent = document.getElementById('logContent_${uniqueId}');
                if (!logContent || matches_${uniqueId}.length === 0) return;
                
                const content = logContent.textContent;
                let result = '';
                let lastIndex = 0;
                
                // Process each match
                for (let i = 0; i < matches_${uniqueId}.length; i++) {
                    const matchStart = matches_${uniqueId}[i];
                    const matchEnd = matchStart + searchText.length;
                    
                    // Add text before the match
                    result += content.substring(lastIndex, matchStart).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    
                    // Add the highlighted match
                    const matchClass = (i === currentMatchIndex_${uniqueId}) ? 'current-match' : 'match';
                    result += '<span class="' + matchClass + '">' + 
                              content.substring(matchStart, matchEnd).replace(/</g, '&lt;').replace(/>/g, '&gt;') + 
                              '</span>';
                    
                    lastIndex = matchEnd;
                }
                
                // Add remaining text after the last match
                result += content.substring(lastIndex).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                
                // Update content
                logContent.innerHTML = result;
                
                // Scroll to current match
                scrollToMatch_${uniqueId}();
            }
            
            // Navigate to next match
            function searchNext_${uniqueId}() {
                // Always get the current search text
                const searchInput = document.getElementById('searchInput_${uniqueId}');
                if (!searchInput || searchInput.value.trim() === '') return;
                
                // If search text has changed or no previous search, perform a new search
                const currentSearchText = searchInput.value.trim();
                const storedSearchText = window['logContent_${uniqueId}_lastSearchText'] || '';
                
                if (currentSearchText !== storedSearchText || matches_${uniqueId}.length === 0) {
                    performSearch_${uniqueId}(currentSearchText);
                    // Store the current search text as a variable
                    window['logContent_${uniqueId}_lastSearchText'] = currentSearchText;
                    return;
                }
                
                // If we have matches and the search text hasn't changed, move to next match
                currentMatchIndex_${uniqueId} = (currentMatchIndex_${uniqueId} + 1) % matches_${uniqueId}.length;
                updateMatchHighlight_${uniqueId}();
            }
            
            // Navigate to previous match
            function searchPrev_${uniqueId}() {
                // Always get the current search text
                const searchInput = document.getElementById('searchInput_${uniqueId}');
                if (!searchInput || searchInput.value.trim() === '') return;
                
                // If search text has changed or no previous search, perform a new search
                const currentSearchText = searchInput.value.trim();
                const storedSearchText = window['logContent_${uniqueId}_lastSearchText'] || '';
                
                if (currentSearchText !== storedSearchText || matches_${uniqueId}.length === 0) {
                    performSearch_${uniqueId}(currentSearchText);
                    // Store the current search text as a variable
                    window['logContent_${uniqueId}_lastSearchText'] = currentSearchText;
                    return;
                }
                
                // If we have matches and the search text hasn't changed, move to previous match
                currentMatchIndex_${uniqueId} = (currentMatchIndex_${uniqueId} - 1 + matches_${uniqueId}.length) % matches_${uniqueId}.length;
                updateMatchHighlight_${uniqueId}();
            }
            
            // Update highlight for current match
            function updateMatchHighlight_${uniqueId}() {
                const searchInfo = document.getElementById('searchInfo_${uniqueId}');
                if (!searchInfo) return;
                
                // Update match counter
                searchInfo.textContent = 'Match ' + (currentMatchIndex_${uniqueId} + 1) + ' of ' + matches_${uniqueId}.length;
                
                // Update highlight classes
                const logContent = document.getElementById('logContent_${uniqueId}');
                if (!logContent) return;
                
                const matchElements = logContent.querySelectorAll('.match, .current-match');
                for (let i = 0; i < matchElements.length; i++) {
                    matchElements[i].className = (i === currentMatchIndex_${uniqueId}) ? 'current-match' : 'match';
                }
                
                // Scroll to current match
                scrollToMatch_${uniqueId}();
            }
            
            // Scroll to current match
            function scrollToMatch_${uniqueId}() {
                const logContent = document.getElementById('logContent_${uniqueId}');
                if (!logContent) return;
                
                const currentMatch = logContent.querySelector('.current-match');
                if (currentMatch) {
                    currentMatch.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    });
                }
            }
        </script>
        
        <style>
            .match {
                background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 255, 0, 0.3));
                border: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent);
                border-radius: 2px;
            }
            .current-match {
                background-color: var(--vscode-editor-findMatchBackground, rgba(255, 153, 0, 0.6));
                border: 1px solid var(--vscode-editor-findMatchBorder, transparent);
                border-radius: 2px;
                font-weight: bold;
            }
        </style>`;
    }

    /**
     * Removes the executed anonymous code sections from the log
     * These sections typically appear at the beginning of the log and show the code being executed
     */
    private static removeExecutedAnonymousCode(log: string): string {
        // First check if we have any Execute Anonymous lines - quick return if not
        if (!log.includes('Execute Anonymous:')) {
            return log;
        }
        
        // Split the log into lines for processing
        const lines = log.split('\n');
        const filteredLines = [];
        let inExecuteAnonymous = false;
        let firstTimestampFound = false;
        
        // Process each line
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Check for the first timestamp pattern which indicates start of actual log data
            if (!firstTimestampFound && line.match(/^\d{1,2}:\d{2}:\d{2}\.\d+\|/)) {
                firstTimestampFound = true;
                filteredLines.push(lines[i]); // Keep the timestamp line
                continue;
            }
            
            // If we've found the first timestamp, include all subsequent lines
            if (firstTimestampFound) {
                filteredLines.push(lines[i]);
                continue;
            }
            
            // For lines before the first timestamp:
            
            // Skip any lines that start with "Execute Anonymous:"
            if (line.startsWith('Execute Anonymous:')) {
                inExecuteAnonymous = true;
                continue;
            }
            
            // Skip empty lines immediately after Execute Anonymous sections
            if (inExecuteAnonymous && line === '') {
                continue;
            }
            
            // For other non-Execute Anonymous lines before the timestamp (like log level settings)
            if (!line.startsWith('Execute Anonymous:') && line !== '') {
                inExecuteAnonymous = false; // Reset the flag
                filteredLines.push(lines[i]); // Keep config lines and other log header info
            }
        }
        
        return filteredLines.join('\n');
    }
} 
