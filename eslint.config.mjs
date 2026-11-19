// @ts-check
/**
 * ESLint 全家桶（flat config）：
 * - eslint-plugin-vue `flat/recommended`（vue3 全量推荐规则，含模板格式规则——
 *   初装 autofix 统一存量风格）
 * - @vue/eslint-config-typescript（typescript-eslint recommended 官方 Vue 接线，
 *   **非 type-aware**——类型级检查交给 tsc strict / vue-tsc，lint 保持秒级）
 * - 架构护栏（前序重构成果的守卫）：
 *   - no-restricted-imports 锁四层依赖方向（shared → 谁都不依赖；preload/renderer
 *     只准依赖 shared；renderer 另禁 node: 内建）
 *   - max-lines 巨型文件护栏（src 650 / tests 1500，skipBlankLines+skipComments；
 *     超限白名单以文件级 override 显式列出并注明削减计划）
 * - lint 已接入 release.yml 质量门（tag 触发，与 typecheck/test/test:e2e 并列）
 */
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default defineConfigWithVueTs(
  {
    name: 'selling-electron/ignores',
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.omo/**',
      '**/*.bak'
    ]
  },

  // ── 全家桶预设 ──
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,

  // ── 运行环境 globals ──
  {
    name: 'selling-electron/globals-node',
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      '*.config.ts',
      '*.config.mts'
    ],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    name: 'selling-electron/globals-browser',
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser } }
  },

  // ── 架构分层锁（IPC 契约/分层重构成果的守卫——违例即构建期报错）──
  {
    name: 'selling-electron/layering-shared',
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/preload/**', '**/renderer/**', '@renderer/*'],
              message:
                'shared 是最底层（跨进程契约/纯函数），禁止反向 import main / preload / renderer'
            }
          ]
        }
      ]
    }
  },
  {
    name: 'selling-electron/layering-preload',
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/renderer/**', '@renderer/*'],
              message: 'preload 只准依赖 shared 与 electron，禁止 import main / renderer'
            }
          ]
        }
      ]
    }
  },
  {
    name: 'selling-electron/layering-renderer',
    files: ['src/renderer/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/preload/**', 'node:*'],
              message:
                'renderer 只准依赖 shared（类型/纯函数），禁止 import main / preload 与 node: 内建模块'
            }
          ]
        }
      ]
    }
  },

  // ── 巨型文件护栏（批次 1–5 拆分成果防回潮；超限白名单显式列出）──
  {
    name: 'selling-electron/max-lines-src',
    files: ['src/**/*.{ts,vue}'],
    rules: {
      'max-lines': ['error', { max: 650, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    name: 'selling-electron/max-lines-tests',
    files: ['tests/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 1500, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    // 存量白名单（递减型——只准降不准升）：TemplateEditorView 批次 4 已拆出
    // 变量说明区/三组段落行编辑器/实时预览面板（1429 → 753 总行 / 723 有效行），
    // 余量为模板列表侧栏 + draft 工厂/CRUD 编排 + 明细列组；再拆「明细列」组
    // 即回 650 以内（后续批次移除本条目）
    name: 'selling-electron/max-lines-whitelist',
    files: ['src/renderer/src/views/TemplateEditorView.vue'],
    rules: {
      'max-lines': ['error', { max: 730, skipBlankLines: true, skipComments: true }]
    }
  },

  // ── 局部豁免与规则参数微调 ──
  {
    name: 'selling-electron/rule-tweaks',
    rules: {
      // `_` 前缀 = 刻意忽略（fake execFile 回调、占位参数——全仓惯例）；
      // 未用变量本体仍报错（与 tsc noUnusedLocals 双保险）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // ignoreReadBeforeAssign：settle↔timer 型循环引用（闭包先读后赋值的
      // 单次延迟赋值 let）改 const 有 TDZ 风险——规则官方选项跳过此类
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }]
    }
  },
  {
    name: 'selling-electron/main-lazy-require',
    files: ['src/main/**/*.ts'],
    rules: {
      // T2 模式（项目约定）：main 侧对 electron 一律**懒 require**——模块顶层
      // import 'electron' 会让 vitest 纯 Node 环境导入即炸；require 点位全部
      // 带注释说明（defaultCreateWindowFn / getElectron 等注入面默认值）
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    name: 'selling-electron/overrides',
    files: ['src/renderer/src/App.vue'],
    rules: {
      // 根组件惯例单名（App）——vue 官方脚手架同款豁免
      'vue/multi-word-component-names': 'off'
    }
  }
)
