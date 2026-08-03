<script setup>
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
</script>
<template>
  <a-config-provider
    :theme="themeStore.currentTheme"
  >
    <router-view />
  </a-config-provider>
</template>
