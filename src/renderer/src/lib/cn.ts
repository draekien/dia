import { createCn } from 'cn/config'

export const cn = createCn({
  extend: {
    theme: {
      radius: ['2xl', '3xl', '4xl', 'card', 'checkbox', 'floor', 'lg', 'md', 'panel', 'sm', 'xl'],
      spacing: ['hit-coarse', 'hit-min', 'related', 'row', 'row-inset', 'run', 'section'],
      text: ['body', 'label', 'micro', 'title'],
      shadow: ['popover'],
      ease: ['out'],
      container: ['abbreviate', 'hide']
    },
    classGroups: {
      duration: [
        {
          duration: ['quick']
        }
      ],
      z: [
        {
          z: ['popover']
        }
      ]
    }
  }
})
