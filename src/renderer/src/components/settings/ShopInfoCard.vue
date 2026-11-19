<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppSettings } from '../../../../shared/types'

/**
 * 设置页·卡片一：店铺信息（小票模板变量源头：shopName / shopPhone / receiptNote）。
 *
 * 卡片自治（SettingsView 拆分，DiagnosisDialog 先例模式）：自持表单态，
 * 挂载时 settings:get 回显、保存走 settings:set、toast 本组件闭环。
 * 卡片骨架样式（settings-card/card-head/card-foot/form-grid/settings-form）
 * 在 assets/settings-cards.css，由 SettingsView 全局加载。
 */

const loading = ref(true)
const savingShop = ref(false)

const shopForm = reactive({ shop_name: '', shop_phone: '', receipt_note: '' })

onMounted(async () => {
  try {
    const settings: AppSettings = await window.api.settings.get()
    shopForm.shop_name = settings.shop_name
    shopForm.shop_phone = settings.shop_phone
    shopForm.receipt_note = settings.receipt_note
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`设置加载失败：${detail}`)
  } finally {
    loading.value = false
  }
})

async function saveShop(): Promise<void> {
  savingShop.value = true
  try {
    await window.api.settings.set({
      shop_name: shopForm.shop_name,
      shop_phone: shopForm.shop_phone,
      receipt_note: shopForm.receipt_note
    })
    ElMessage.success('店铺信息已保存')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`保存失败：${detail}`)
  } finally {
    savingShop.value = false
  }
}
</script>

<template>
  <!-- ═══ 卡片一：店铺信息（小票模板变量源头：shopName / shopPhone / receiptNote）═══ -->
  <el-card
    v-loading="loading"
    class="settings-card"
    shadow="never"
  >
    <template #header>
      <div class="card-head">
        <span
          class="card-head__marker"
          aria-hidden="true"
        />
        <span class="card-head__title">店铺信息</span>
        <span class="card-head__desc">打印在小票头部与底部</span>
      </div>
    </template>

    <el-form
      label-position="top"
      class="settings-form"
      @submit.prevent
    >
      <div class="form-grid">
        <el-form-item label="店名">
          <el-input
            v-model="shopForm.shop_name"
            data-testid="shop-name-input"
            placeholder="如：好又多超市"
            maxlength="30"
          />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input
            v-model="shopForm.shop_phone"
            data-testid="shop-phone-input"
            placeholder="如：138-0000-0000"
            maxlength="20"
          />
        </el-form-item>
      </div>
      <el-form-item label="小票备注">
        <el-input
          v-model="shopForm.receipt_note"
          type="textarea"
          :rows="2"
          maxlength="60"
          show-word-limit
          data-testid="receipt-note-input"
          placeholder="如：谢谢惠顾，欢迎再次光临"
        />
      </el-form-item>
    </el-form>

    <footer class="card-foot">
      <span class="card-foot__hint">保存后，新小票的店名 / 电话 / 备注随之更新。</span>
      <el-button
        type="primary"
        data-testid="save-shop-btn"
        :loading="savingShop"
        @click="saveShop"
      >
        保存
      </el-button>
    </footer>
  </el-card>
</template>
