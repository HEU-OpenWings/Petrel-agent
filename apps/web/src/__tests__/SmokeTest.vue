<template>
  <div data-testid="smoke">{{ msg }}</div>
  <button data-testid="increment" @click="count++">{{ count }}</button>
</template>

<script setup>
import { ref } from "vue";

const msg = "hello";
const count = ref(0);
</script>
