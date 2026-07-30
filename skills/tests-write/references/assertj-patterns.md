# AssertJ Patterns Catalog

## Object Equality

```java
assertThat(actualProduct).isEqualTo(expectedProduct);
assertThat(actualProduct).isEqualToIgnoringGivenFields(expectedProduct, "id");
```

## Collection Assertions

```java
assertThat(actualList).hasSize(5);
assertThat(actualList).contains(expected);
assertThat(actualList).containsExactly(item1, item2);
assertThat(actualList).containsOnly("1", "2");
assertThat(actualList).isEmpty();
assertThat(actualList).isNotEmpty();
```

## Collection with Field Extraction

```java
assertThat(actualList)
    .extracting(Product::getId)
    .containsExactly("1", "2");

assertThat(actualList)
    .extracting(Product::getName, Product::getCategory)
    .containsExactly(tuple("Phone", "Electronics"), tuple("Pen", "Office"));
```

## Collection Element Assertions

```java
assertThat(actualList)
    .anySatisfy(product ->
        assertThat(product.getDateCreated()).isBetween(instant1, instant2));

assertThat(actualList)
    .allSatisfy(product ->
        assertThat(product.isActive()).isTrue());

assertThat(actualList)
    .filteredOn(product -> product.getCategory().equals("Smartphone"))
    .allSatisfy(product ->
        assertThat(product.isLiked()).isTrue());
```

## Ignoring Fields in Collections

```java
assertThat(actualList)
    .usingElementComparatorIgnoringFields("id")
    .containsExactly(expectedProduct1, expectedProduct2);

assertThat(actualList)
    .usingRecursiveComparison()
    .ignoringFields("id", "createdAt")
    .isEqualTo(expectedList);
```

## String Assertions

```java
assertThat(actual).isEqualTo("expected");
assertThat(actual).contains("substring");
assertThat(actual).startsWith("prefix");
assertThat(actual).matches("regex.*pattern");
assertThat(actual).isBlank();
```

## Exception Assertions

```java
assertThatThrownBy(() -> service.process(null))
    .isInstanceOf(IllegalArgumentException.class)
    .hasMessageContaining("must not be null");

assertThatCode(() -> service.process(validInput))
    .doesNotThrowAnyException();
```

## Optional Assertions

```java
assertThat(optional).isPresent();
assertThat(optional).isEmpty();
assertThat(optional).hasValue(expected);
```

## Map Assertions

```java
assertThat(map).containsKey("key");
assertThat(map).containsEntry("key", "value");
assertThat(map).hasSize(3);
```
