// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import '/flutter_flow/flutter_flow_util.dart';

class ProductDataStruct extends FFFirebaseStruct {
  ProductDataStruct({
    String? name,
    String? description,
    double? price,
    String? photoUrl,
    DocumentReference? productRef,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _name = name,
        _description = description,
        _price = price,
        _photoUrl = photoUrl,
        _productRef = productRef,
        super(firestoreUtilData);

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  set name(String? val) => _name = val;

  bool hasName() => _name != null;

  // "description" field.
  String? _description;
  String get description => _description ?? '';
  set description(String? val) => _description = val;

  bool hasDescription() => _description != null;

  // "price" field.
  double? _price;
  double get price => _price ?? 0.0;
  set price(double? val) => _price = val;

  void incrementPrice(double amount) => price = price + amount;

  bool hasPrice() => _price != null;

  // "photo_url" field.
  String? _photoUrl;
  String get photoUrl => _photoUrl ?? '';
  set photoUrl(String? val) => _photoUrl = val;

  bool hasPhotoUrl() => _photoUrl != null;

  // "product_ref" field.
  DocumentReference? _productRef;
  DocumentReference? get productRef => _productRef;
  set productRef(DocumentReference? val) => _productRef = val;

  bool hasProductRef() => _productRef != null;

  static ProductDataStruct fromMap(Map<String, dynamic> data) =>
      ProductDataStruct(
        name: data['name'] as String?,
        description: data['description'] as String?,
        price: castToType<double>(data['price']),
        photoUrl: data['photo_url'] as String?,
        productRef: data['product_ref'] as DocumentReference?,
      );

  static ProductDataStruct? maybeFromMap(dynamic data) => data is Map
      ? ProductDataStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'name': _name,
        'description': _description,
        'price': _price,
        'photo_url': _photoUrl,
        'product_ref': _productRef,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'name': serializeParam(
          _name,
          ParamType.String,
        ),
        'description': serializeParam(
          _description,
          ParamType.String,
        ),
        'price': serializeParam(
          _price,
          ParamType.double,
        ),
        'photo_url': serializeParam(
          _photoUrl,
          ParamType.String,
        ),
        'product_ref': serializeParam(
          _productRef,
          ParamType.DocumentReference,
        ),
      }.withoutNulls;

  static ProductDataStruct fromSerializableMap(Map<String, dynamic> data) =>
      ProductDataStruct(
        name: deserializeParam(
          data['name'],
          ParamType.String,
          false,
        ),
        description: deserializeParam(
          data['description'],
          ParamType.String,
          false,
        ),
        price: deserializeParam(
          data['price'],
          ParamType.double,
          false,
        ),
        photoUrl: deserializeParam(
          data['photo_url'],
          ParamType.String,
          false,
        ),
        productRef: deserializeParam(
          data['product_ref'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['products'],
        ),
      );

  static ProductDataStruct fromAlgoliaData(Map<String, dynamic> data) =>
      ProductDataStruct(
        name: convertAlgoliaParam(
          data['name'],
          ParamType.String,
          false,
        ),
        description: convertAlgoliaParam(
          data['description'],
          ParamType.String,
          false,
        ),
        price: convertAlgoliaParam(
          data['price'],
          ParamType.double,
          false,
        ),
        photoUrl: convertAlgoliaParam(
          data['photo_url'],
          ParamType.String,
          false,
        ),
        productRef: convertAlgoliaParam(
          data['product_ref'],
          ParamType.DocumentReference,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'ProductDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    return other is ProductDataStruct &&
        name == other.name &&
        description == other.description &&
        price == other.price &&
        photoUrl == other.photoUrl &&
        productRef == other.productRef;
  }

  @override
  int get hashCode => const ListEquality()
      .hash([name, description, price, photoUrl, productRef]);
}

ProductDataStruct createProductDataStruct({
  String? name,
  String? description,
  double? price,
  String? photoUrl,
  DocumentReference? productRef,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    ProductDataStruct(
      name: name,
      description: description,
      price: price,
      photoUrl: photoUrl,
      productRef: productRef,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

ProductDataStruct? updateProductDataStruct(
  ProductDataStruct? productData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    productData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addProductDataStructData(
  Map<String, dynamic> firestoreData,
  ProductDataStruct? productData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (productData == null) {
    return;
  }
  if (productData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && productData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final productDataData =
      getProductDataFirestoreData(productData, forFieldValue);
  final nestedData =
      productDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = productData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getProductDataFirestoreData(
  ProductDataStruct? productData, [
  bool forFieldValue = false,
]) {
  if (productData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(productData.toMap());

  // Add any Firestore field values
  productData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getProductDataListFirestoreData(
  List<ProductDataStruct>? productDatas,
) =>
    productDatas?.map((e) => getProductDataFirestoreData(e, true)).toList() ??
    [];
