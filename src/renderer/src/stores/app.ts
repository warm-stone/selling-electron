import { defineStore } from 'pinia'

/**
 * 全局应用 store（Task 6 骨架）
 * 后续业务 store（商品/购物车/销售记录等）在本目录按域拆分独立文件；
 * 当前仅承载应用级展示信息，验证 pinia 接线。
 */
export const useAppStore = defineStore('app', {
  state: () => ({
    /** 应用名（侧边栏品牌区展示） */
    appName: '桌面销存系统'
  })
})
