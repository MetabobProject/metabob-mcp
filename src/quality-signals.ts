/**
 * Quality signals for tool output
 * Provides warnings and guidance when data quality is low
 */

export interface QualitySignals {
  cpg_status?: 'empty' | 'indexing' | 'ready';
  components_analyzed?: number;
  historical_patterns_found?: number;
  embedding_model_loaded?: boolean;
}

/**
 * Format quality signals as warnings/guidance for tool output
 */
export function formatQualitySignals(signals: QualitySignals): string {
  const warnings: string[] = [];

  // CPG status warnings
  if (signals.cpg_status === 'empty') {
    warnings.push(
      '⚠️  CPG not indexed - Run `init_workspace` first to enable semantic analysis'
    );
  } else if (signals.cpg_status === 'indexing') {
    warnings.push(
      '⏳ CPG indexing in progress - Results may be incomplete'
    );
  }

  // Component count guidance
  if (signals.components_analyzed !== undefined) {
    if (signals.components_analyzed === 0) {
      warnings.push(
        '📊 No components analyzed - Index your workspace for better results'
      );
    } else if (signals.components_analyzed < 10) {
      warnings.push(
        `📊 Only ${signals.components_analyzed} components indexed - Results may be limited`
      );
    }
  }

  // Historical patterns guidance
  if (signals.historical_patterns_found !== undefined) {
    if (signals.historical_patterns_found === 0) {
      warnings.push(
        '📈 No historical co-change patterns found - Predictions based on semantic similarity only'
      );
    }
  }

  if (warnings.length === 0) {
    return '';
  }

  return '\n---\n' + warnings.join('\n') + '\n';
}

/**
 * Extract quality signals from API response
 */
export function extractQualitySignals(response: Record<string, unknown>): QualitySignals {
  const signals: QualitySignals = {};

  if ('cpg_status' in response) {
    signals.cpg_status = response.cpg_status as QualitySignals['cpg_status'];
  }

  if ('components_analyzed' in response) {
    signals.components_analyzed = response.components_analyzed as number;
  } else if ('components_searched' in response) {
    signals.components_analyzed = response.components_searched as number;
  } else if ('components_found' in response) {
    signals.components_analyzed = response.components_found as number;
  }

  if ('historical_patterns_found' in response) {
    signals.historical_patterns_found = response.historical_patterns_found as number;
  }

  return signals;
}
