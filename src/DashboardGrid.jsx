import React from 'react';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import { Move } from 'lucide-react';
import { DEFAULT_LAYOUT } from './useSettings.js';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

export const TILE_LABELS = {
  'stat-cards':    'Summary Cards',
  'expense-table': 'Expense Breakdown',
  'donut-chart':   'Spending Distribution',
  'bar-chart':     'Actual vs Budget',
  'insight-cards': 'Insight Cards',
  'non-monthly':   'Non-Monthly Expenses',
  'budget-rules':  '50/30/20 Rules',
};

export function DashboardGrid({ layout, editLayout, onLayoutChange, tiles }) {
  const { containerRef, width: containerWidth } = useContainerWidth();

  return (
    <div ref={containerRef}>
      {editLayout && (
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse flex-shrink-0" />
          <p className="text-xs font-bold text-indigo-500 dark:text-indigo-400">
            Layout editing — drag tiles to move, pull the corner handle to resize
          </p>
        </div>
      )}

      <GridLayout
        layout={layout}
        onLayoutChange={onLayoutChange}
        width={containerWidth || 1200}
        cols={12}
        rowHeight={60}
        isDraggable={editLayout}
        isResizable={editLayout}
        draggableHandle=".tile-handle"
        margin={[16, 16]}
        containerPadding={[0, 0]}
        compactType="vertical"
        useCSSTransforms
      >
        {layout.map(item => (
          <div
            key={item.i}
            className={`flex flex-col overflow-hidden rounded-[2rem] transition-all ${
              editLayout
                ? 'ring-2 ring-indigo-400/60 dark:ring-indigo-500/50 shadow-xl shadow-indigo-100/60 dark:shadow-indigo-900/20'
                : ''
            }`}
          >
            {/* Drag handle — only in edit mode */}
            {editLayout && (
              <div className="tile-handle flex-shrink-0 flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-xs font-bold cursor-grab active:cursor-grabbing select-none rounded-t-[2rem]">
                <Move className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{TILE_LABELS[item.i] || item.i}</span>
                <span className="ml-auto text-indigo-300/80 text-[10px] hidden sm:block whitespace-nowrap">
                  drag · resize ↘
                </span>
              </div>
            )}

            {/* Content */}
            <div
              className={`flex-1 min-h-0 overflow-auto ${
                editLayout ? 'pointer-events-none opacity-70' : ''
              }`}
            >
              {tiles[item.i]}
            </div>
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
