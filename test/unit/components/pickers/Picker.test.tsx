import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/preact";
import { Picker, type PickerRenderRowArgs } from "../../../../src/ui/components/pickers/Picker.tsx";

interface Item {
  name: string;
}
const items: Item[] = [{ name: "alpha" }, { name: "bravo" }, { name: "charlie" }];

const makeProps = (over: Partial<Parameters<typeof Picker<Item>>[0]> = {}) => ({
  items,
  filterText: (i: Item) => i.name,
  onSelect: mock((_: Item) => {}),
  renderRow: ({ item, isCursor, onClick }: PickerRenderRowArgs<Item>) => (
    <button class={`picker-row${isCursor ? " cursor" : ""}`} onClick={onClick}>
      {item.name}
    </button>
  ),
  ...over,
});

const getSearch = () => document.querySelector(".picker-search input") as HTMLInputElement;

describe("Picker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("renders all items as picker-rows", () => {
    render(<Picker {...makeProps()} />);
    expect(document.querySelectorAll(".picker-row").length).toBe(3);
  });

  test("typing filters items by substring", async () => {
    render(<Picker {...makeProps()} />);
    fireEvent.input(getSearch(), { target: { value: "bra" } });
    await new Promise(r => setTimeout(r, 5));
    const rows = document.querySelectorAll(".picker-row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toBe("bravo");
  });

  test("ArrowDown moves cursor; Enter calls onSelect for that item", async () => {
    const props = makeProps();
    render(<Picker {...props} />);
    const input = getSearch();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await new Promise(r => setTimeout(r, 5));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith({ name: "bravo" });
  });

  test("createRow + onCreate fires when Enter on the create row", async () => {
    const onCreate = mock((_: string) => {});
    render(
      <Picker
        {...makeProps({
          onCreate,
          createRow: ({ query, isCursor, onClick }) =>
            query ? (
              <button class={`picker-row create${isCursor ? " cursor" : ""}`} onClick={onClick}>
                Create {query}
              </button>
            ) : null,
        })}
      />,
    );
    const input = getSearch();
    fireEvent.input(input, { target: { value: "zzz" } });
    await new Promise(r => setTimeout(r, 5));
    // After filter, list is empty + 1 create row → cursor lands on create (index 0).
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("zzz");
  });

  test("empty-state message shown when no matches and no create row", async () => {
    render(<Picker {...makeProps({ emptyText: "nothing" })} />);
    fireEvent.input(getSearch(), { target: { value: "zzz" } });
    await new Promise(r => setTimeout(r, 5));
    expect(document.querySelector(".picker-empty")?.textContent).toBe("nothing");
  });
});
